import * as fs from "node:fs";
import {
  addAssistantMessage,
  addUserMessage,
  type MessageParam,
} from "@/core/index.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";
import { loadPromptVersion } from "@/eval/prompts.ts";
import { datasetPath, runsPath } from "@/eval/paths.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import {
  DatasetItemSchema,
  RunRowSchema,
  type RunRow,
} from "@/eval/types.ts";

export async function runPromptOnDataset(opts: {
  name: string;
  version: string;
  model?: string;
  force?: boolean;
}) {
  const outPath = runsPath(opts.name, opts.version);

  if (!opts.force && fs.existsSync(outPath)) {
    const cached = readJsonl(outPath).map((row, i) => {
      const result = RunRowSchema.safeParse(row);
      if (!result.success) {
        throw new Error(`cached runs row ${i} invalid: ${result.error.message}`);
      }
      return result.data;
    });
    process.stderr.write(
      `[run] cache hit: ${outPath} (${cached.length} rows; --force to re-run)\n`,
    );
    return { path: outPath, count: cached.length, cached: true };
  }

  const system = loadPromptVersion(opts.name, opts.version);
  const items = readJsonl(datasetPath(opts.name)).map((row, i) => {
    const result = DatasetItemSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`dataset row ${i} invalid: ${result.error.message}`);
    }
    return result.data;
  });

  const rows: RunRow[] = [];
  const model = opts.model ?? DEFAULT_MODEL;
  for (const [i, item] of items.entries()) {
    process.stderr.write(`[run] ${i + 1}/${items.length}\n`);
    const messages: MessageParam[] = [];
    addUserMessage(messages, item.input);
    const response = await addAssistantMessage(messages, {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system,
    });
    const textBlock = response.content.find((b) => b.type === "text");
    const output = textBlock && textBlock.type === "text" ? textBlock.text : "";
    rows.push({ ...item, output });
  }

  writeJsonl(outPath, rows);
  return { path: outPath, count: rows.length, cached: false };
}
