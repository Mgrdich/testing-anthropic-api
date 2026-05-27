import {
  addAssistantMessage,
  addUserMessage,
  type MessageParam,
} from "@/core/index.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";
import { loadPromptVersion } from "@/eval/prompts.ts";
import { datasetPath, runsPath } from "@/eval/paths.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import { DatasetItemSchema, type RunRow } from "@/eval/types.ts";

export async function runPromptOnDataset(opts: {
  name: string;
  version: string;
  model?: string;
}): Promise<{ path: string; count: number }> {
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

  const outPath = runsPath(opts.name, opts.version);
  writeJsonl(outPath, rows);
  return { path: outPath, count: rows.length };
}
