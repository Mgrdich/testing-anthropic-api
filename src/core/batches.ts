import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@/core/client.ts";
import { Debug } from "@/core/debug.ts";

/** One entry in a Message Batch: `{ custom_id, params }`. */
export type BatchRequest =
  Anthropic.Messages.BatchCreateParams["requests"][number];

/**
 * Per-request outcome: `succeeded` (carries the `Message`), `errored`,
 * `canceled`, or `expired`. Discriminated on `.type`.
 */
export type BatchResult = Anthropic.Messages.MessageBatchResult;

export type RunMessageBatchOptions = {
  /** Poll interval for `batches.retrieve` while processing. Default 5000. */
  pollMs?: number;
  /**
   * Give up waiting after this long (default 1h; the API's own ceiling is
   * 24h). The batch keeps processing server-side — the throw carries its id
   * so results can still be collected later.
   */
  maxWaitMs?: number;
  /** Called once with the batch id, before the first poll. */
  onCreate?: (batchId: string) => void;
};

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 60 * 60_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a Message Batch end-to-end: create the batch, poll `retrieve` until
 * `processing_status === "ended"`, then stream `.results()` into a Map keyed
 * by `custom_id`. Results arrive in arbitrary order — callers reassemble by
 * key, never by position. Batched requests are billed at 50% of standard
 * prices; most batches finish well under an hour.
 */
export async function runMessageBatch(
  requests: BatchRequest[],
  opts: RunMessageBatchOptions = {},
): Promise<Map<string, BatchResult>> {
  const dbg = Debug.get();
  const client = AnthropicClient.get();
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  let batch = await client.messages.batches.create({ requests });
  // The id is the only handle on a batch that outlives this process, so it
  // goes to the caller unconditionally — not just under --debug.
  opts.onCreate?.(batch.id);
  dbg.log(() => `batch created: ${batch.id} (${requests.length} requests)`);

  const deadline = Date.now() + maxWaitMs;
  while (batch.processing_status !== "ended") {
    if (Date.now() >= deadline) {
      throw new Error(
        `batch ${batch.id} still ${batch.processing_status} after ${Math.round(
          maxWaitMs / 1000,
        )}s; it keeps running server-side — retrieve its results by id`,
      );
    }
    dbg.log(
      () =>
        `batch ${batch.id}: ${batch.processing_status} ` +
        `(processing=${batch.request_counts.processing}); ` +
        `next poll in ${pollMs}ms`,
    );
    await sleep(pollMs);
    batch = await client.messages.batches.retrieve(batch.id);
  }
  dbg.json(`batch ${batch.id} ended`, () => batch.request_counts);

  const results = new Map<string, BatchResult>();
  for await (const entry of await client.messages.batches.results(batch.id)) {
    results.set(entry.custom_id, entry.result);
  }
  dbg.log(() => `batch ${batch.id}: collected ${results.size} results`);
  return results;
}
