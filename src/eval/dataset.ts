import * as fs from "node:fs";
import { z } from "zod";
import {
  addUserMessage,
  type MessageParam,
  parseAssistantMessage,
} from "@/core/index.ts";
import { writeJsonl } from "@/eval/jsonl.ts";
import { datasetPath } from "@/eval/paths.ts";
import { loadAuxPrompt } from "@/eval/prompts.ts";
import { type DatasetItem, DatasetItemSchema } from "@/eval/types.ts";

const GEN_MODEL = "claude-haiku-4-5-20251001";
const GEN_MAX_TOKENS = 4096;

// Structured output: the model is constrained to emit a JSON object whose
// `items` array matches DatasetItemSchema. This replaces the old prefill
// (` ```json\n[ `) + stop (` ]\n``` `) fencing, the `[${text}]`
// reconstruction, and the bracket-scraping/per-item drop fallback — the SDK
// parses and Zod-validates the whole payload for us. (The output format wraps
// a single object, so the array is nested under `items`.)
const GenResultSchema = z.object({ items: z.array(DatasetItemSchema) });

export async function generateDataset(opts: {
  name: string;
  count: number;
  force: boolean;
}) {
  const outPath = datasetPath(opts.name);
  if (fs.existsSync(outPath) && !opts.force) {
    throw new Error(`${outPath} already exists. Pass --force to overwrite.`);
  }

  const system = loadAuxPrompt(opts.name, "generate").replaceAll(
    "{count}",
    String(opts.count),
  );

  const messages: MessageParam[] = [];
  addUserMessage(messages, `Generate ${opts.count} items now.`);

  const { parsed } = await parseAssistantMessage(messages, GenResultSchema, {
    model: GEN_MODEL,
    max_tokens: GEN_MAX_TOKENS,
    system,
  });

  const items: DatasetItem[] = parsed.items;
  if (items.length === 0) {
    throw new Error(
      `model returned 0 items (expected ${opts.count}); check generate.txt or raise GEN_MAX_TOKENS`,
    );
  }

  writeJsonl(outPath, items);
  return { path: outPath, count: items.length };
}
