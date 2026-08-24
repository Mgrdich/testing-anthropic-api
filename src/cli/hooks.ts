import type * as readline from "node:readline/promises";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { type AgenticHooks, Debug, MUTATING_TOOLS } from "@/core/index.ts";

const dbg = Debug.get();

const TOOL_RESULT_PREVIEW_MAX = 200;

// Dim ANSI styling for [thinking] output — only when stderr is a terminal,
// so piped diagnostics stay free of escape codes.
const DIM = process.stderr.isTTY ? "\x1b[2m" : "";
const RESET = process.stderr.isTTY ? "\x1b[0m" : "";

/**
 * Render a complete thinking block's text to stderr (non-streaming path).
 * Dim + "[thinking]" prefix, matching the streamed rendering below.
 */
export function writeThinking(text: string) {
  process.stderr.write(`${DIM}[thinking] ${text}${RESET}\n`);
}

/**
 * Wire the MessageStream "thinking" event to stderr with a dim "[thinking]"
 * prefix. Shared by both stream-listener sites (the single-shot path in
 * repl.ts and buildAgenticHooks' onStream) so `--thinking` renders
 * identically everywhere. The SDK's "thinking" event only carries
 * thinking_delta payloads — signature_delta never reaches it, so it is
 * ignored for display by construction. A content_block_stop while mid-
 * thinking closes the styling and drops to a fresh line (multiple thinking
 * blocks each get their own prefix).
 */
export function attachThinkingListener(stream: MessageStream) {
  let inThinking = false;
  stream.on("thinking", (delta) => {
    if (!inThinking) {
      process.stderr.write(`${DIM}[thinking] `);
      inThinking = true;
    }
    process.stderr.write(delta);
  });
  stream.on("streamEvent", (event) => {
    if (inThinking && event.type === "content_block_stop") {
      process.stderr.write(`${RESET}\n`);
      inThinking = false;
    }
  });
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function buildAgenticHooks(
  rl: readline.Interface | undefined,
): AgenticHooks {
  return {
    onStream: (stream) => {
      if (dbg.enabled) {
        stream.on("streamEvent", (event) => {
          dbg.json(`stream event ${event.type}`, event);
        });
        stream.on("error", (err) => {
          dbg.json("stream error", { message: String(err) });
        });
      }
      attachThinkingListener(stream);
      stream.on("text", (delta) => process.stdout.write(delta));
    },
    onRound: (info) => {
      dbg.json("agentic round", info);
    },
    onToolCall: (name, input, caller) => {
      process.stdout.write("\n");
      // Under --ptc the call comes from a script in the code-execution
      // container rather than straight from the model; annotate the trace so
      // the two are distinguishable. "direct" is the default — stay quiet.
      const via = caller && caller !== "direct" ? ` via ${caller}` : "";
      process.stderr.write(`[tool] ${name}(${compactJson(input)})${via}\n`);
      dbg.json("tool call", { name, input, caller });
    },
    onToolResult: (name, result, isError) => {
      const sigil = isError ? "✗" : "→";
      const shown = dbg.enabled
        ? result
        : truncate(result, TOOL_RESULT_PREVIEW_MAX);
      // Prefix with the tool name so concurrent results stay readable
      // when multiple tools fire in one round.
      process.stderr.write(`  ${sigil} ${name}: ${shown}\n`);
      dbg.json("tool result", { name, result, isError });
    },
    isMutating: (name) => MUTATING_TOOLS.has(name),
    approveMutating: async (name, input) => {
      if (!rl) {
        throw new Error(
          `mutating tool '${name}' requires an interactive TTY for approval; not supported in --once / piped mode`,
        );
      }
      const ans = (
        await rl.question(`approve ${name}(${compactJson(input)})? [y/N] `)
      )
        .trim()
        .toLowerCase();
      return ans === "y" || ans === "yes";
    },
  };
}
