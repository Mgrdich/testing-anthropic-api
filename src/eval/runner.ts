import * as fs from "node:fs";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";
import {
  addAssistantMessage,
  addUserMessage,
  type BatchRequest,
  extractText,
  type MessageParam,
  runMessageBatch,
} from "@/core/index.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import { datasetPath, runsPath } from "@/eval/paths.ts";
import { loadPromptVersion } from "@/eval/prompts.ts";
import {
  type DatasetItem,
  DatasetItemSchema,
  type RunRow,
  RunRowSchema,
} from "@/eval/types.ts";

async function runSequential(
  items: DatasetItem[],
  system: string,
  model: string,
): Promise<RunRow[]> {
  const rows: RunRow[] = [];
  for (const [i, item] of items.entries()) {
    process.stderr.write(`[run] ${i + 1}/${items.length}\n`);
    const messages: MessageParam[] = [];
    addUserMessage(messages, item.input);
    const response = await addAssistantMessage(messages, {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system,
    });
    rows.push({ ...item, output: extractText(response.content) });
  }
  return rows;
}

/**
 * Batch path: one Message Batch request per dataset item
 * (`custom_id: item-<index>`), mirroring the sequential path's params.
 * Results come back keyed by custom_id in arbitrary order, so rows are
 * reassembled in dataset order — downstream code/grade joins are by row
 * index and would silently mispair otherwise. Errored/expired/canceled
 * items become `{ ...item, output: "" }` with a stderr warning so
 * `RunRowSchema` still validates and one bad item never sinks the run.
 */
async function runBatched(
  items: DatasetItem[],
  system: string,
  model: string,
): Promise<RunRow[]> {
  const requests: BatchRequest[] = items.map((item, i) => ({
    custom_id: `item-${i}`,
    params: {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: item.input }],
    },
  }));

  process.stderr.write(`[run] submitting batch (${items.length} requests)\n`);
  const results = await runMessageBatch(requests, {
    // Print the id even without --debug: an interrupted run is otherwise
    // unrecoverable, and the batch is billed either way.
    onCreate: (id) => process.stderr.write(`[run] batch id: ${id}\n`),
  });

  const rows: RunRow[] = [];
  for (const [i, item] of items.entries()) {
    const result = results.get(`item-${i}`);
    if (result?.type === "succeeded") {
      rows.push({ ...item, output: extractText(result.message.content) });
    } else {
      const why = result ? result.type : "missing from batch results";
      process.stderr.write(
        `[run] warning: item-${i} ${why}; recording empty output\n`,
      );
      rows.push({ ...item, output: "" });
    }
  }
  return rows;
}

export async function runPromptOnDataset(opts: {
  name: string;
  version: string;
  model?: string;
  batch?: boolean;
  force?: boolean;
}) {
  const outPath = runsPath(opts.name, opts.version);

  if (!opts.force && fs.existsSync(outPath)) {
    const cached = readJsonl(outPath).map((row, i) => {
      const result = RunRowSchema.safeParse(row);
      if (!result.success) {
        throw new Error(
          `cached runs row ${i} invalid: ${result.error.message}`,
        );
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

  const model = opts.model ?? DEFAULT_MODEL;
  const rows = opts.batch
    ? await runBatched(items, system, model)
    : await runSequential(items, system, model);

  writeJsonl(outPath, rows);
  return { path: outPath, count: rows.length, cached: false };
}
