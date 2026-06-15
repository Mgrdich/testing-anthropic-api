import type * as readline from "node:readline/promises";
import {
  Debug,
  MUTATING_TOOLS,
  type AgenticHooks,
} from "@/core/index.ts";

const dbg = Debug.get();

const TOOL_RESULT_PREVIEW_MAX = 200;

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
      stream.on("text", (delta) => process.stdout.write(delta));
    },
    onRound: (info) => {
      dbg.json("agentic round", info);
    },
    onToolCall: (name, input) => {
      process.stdout.write("\n");
      process.stderr.write(`[tool] ${name}(${compactJson(input)})\n`);
      dbg.json("tool call", { name, input });
    },
    onToolResult: (name, result, isError) => {
      const sigil = isError ? "✗" : "→";
      const shown = dbg.enabled ? result : truncate(result, TOOL_RESULT_PREVIEW_MAX);
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
