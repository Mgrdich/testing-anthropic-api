import * as fs from "node:fs";
import {
  addAssistantMessage,
  addUserMessage,
  type MessageParam,
} from "@/core/index.ts";
import { loadAuxPrompt } from "@/eval/prompts.ts";
import { datasetPath } from "@/eval/paths.ts";
import { writeJsonl } from "@/eval/jsonl.ts";
import { DatasetItemSchema, type DatasetItem } from "@/eval/types.ts";

const GEN_MODEL = "claude-haiku-4-5-20251001";
const GEN_MAX_TOKENS = 4096;
// TODO: replace prefill + stop with a tool-use call. A tool whose
// input_schema is a JSON array of DatasetItem will give us structured
// output without prefill hacks, stop-sequence brittleness, or
// prose-extraction fallbacks.
//
// Until then: prefill opens a ```json fenced block AND the opening
// `[`, and stop is the closing `]` glued to the closing fence. The
// multi-char stop won't collide with `]` inside item content (unlike a
// bare `]` stop). Prefill must not end with whitespace per the API.
const GEN_PREFILL = "```json\n[";
const GEN_STOP = "]\n```";

function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `model did not return a JSON array (no '[' or ']' found):\n${text}`,
    );
  }
  return JSON.parse(text.slice(start, end + 1));
}

export async function generateDataset(opts: {
  name: string;
  count: number;
  force: boolean;
}): Promise<{ path: string; count: number }> {
  const outPath = datasetPath(opts.name);
  if (fs.existsSync(outPath) && !opts.force) {
    throw new Error(
      `${outPath} already exists. Pass --force to overwrite.`,
    );
  }

  const system = loadAuxPrompt(opts.name, "generate").replaceAll(
    "{count}",
    String(opts.count),
  );

  const messages: MessageParam[] = [];
  addUserMessage(
    messages,
    `Generate ${opts.count} items now. Respond with only the JSON array.`,
  );

  const response = await addAssistantMessage(
    messages,
    {
      model: GEN_MODEL,
      max_tokens: GEN_MAX_TOKENS,
      system,
      stop_sequences: [GEN_STOP],
    },
    GEN_PREFILL,
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("model response had no text block");
  }

  // Body returned by the API is what came between the prefill `[` and
  // the stop `]\n```` — i.e. just the items. We reconstruct the full
  // JSON array by wrapping with `[ ... ]`. Stop sequences are consumed
  // by the API; if the stop didn't fire, the body was truncated (likely
  // max_tokens) and we surface the parse error rather than paper over it.
  if (
    response.stop_reason !== "stop_sequence" ||
    response.stop_sequence !== GEN_STOP
  ) {
    process.stderr.write(
      `warning: gen did not hit closing fence (stop_reason=${response.stop_reason}); output may be truncated\n`,
    );
  }

  const reconstructed = `[${textBlock.text}]`;

  if (process.env.EVAL_DEBUG) {
    process.stderr.write(
      `[eval gen] stop_reason=${response.stop_reason} stop_seq=${JSON.stringify(response.stop_sequence)}\n`,
    );
    process.stderr.write(`[eval gen] reconstructed:\n${reconstructed}\n`);
  }

  const raw = extractJsonArray(reconstructed);
  if (!Array.isArray(raw)) {
    throw new Error(`expected a JSON array, got ${typeof raw}`);
  }

  const items: DatasetItem[] = [];
  const errors: string[] = [];
  raw.forEach((row, i) => {
    const result = DatasetItemSchema.safeParse(row);
    if (result.success) items.push(result.data);
    else
      errors.push(
        `item ${i}: ${result.error.issues
          .map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`)
          .join("; ")}`,
      );
  });

  if (items.length === 0) {
    throw new Error(
      `no valid items in model response. Errors:\n  ${errors.join("\n  ")}`,
    );
  }

  if (errors.length > 0) {
    process.stderr.write(
      `warning: dropped ${errors.length} invalid item(s):\n  ${errors.join("\n  ")}\n`,
    );
  }

  writeJsonl(outPath, items);
  return { path: outPath, count: items.length };
}
