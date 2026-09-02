import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * A push-style `AsyncIterable<SDKUserMessage>` — the prompt side of a
 * streaming-input `query()`.
 *
 * Streaming input is used for **every** mode, including `--once` and piped
 * stdin, rather than the simpler string-prompt form. Two reasons: every
 * `Query` control method (`interrupt`, `setModel`, `setPermissionMode`) is
 * documented as streaming-input-only, and a string-prompt query throws after
 * yielding an error result. One shape everywhere removes a class of
 * divergence between the REPL and single-shot paths.
 */
export type Inbox = {
  stream: () => AsyncGenerator<SDKUserMessage>;
  push: (text: string) => void;
  close: () => void;
};

export function createInbox(): Inbox {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      // `shift()` is `T | undefined` under noUncheckedIndexedAccess; narrow
      // rather than asserting.
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    stream,
    push(text) {
      // `uuid` and `session_id` are optional on SDKUserMessage — the CLI
      // assigns them.
      pending.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
  };
}
