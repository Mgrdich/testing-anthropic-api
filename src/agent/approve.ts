import type * as readline from "node:readline/promises";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { unqualify } from "@/agent/tools/builtins.ts";
import { MUTATING_TOOLS } from "@/core/index.ts";

/**
 * Holder for the REPL's readline interface. The session is constructed before
 * the REPL exists (and never gets one in `--once` / piped mode), so the gate
 * reads it indirectly rather than capturing it.
 */
export type RlRef = { current?: readline.Interface };

/** `MUTATING_TOOLS` gates by bare name; the model calls the qualified one. */
export function isMutatingAgentTool(toolName: string) {
  return MUTATING_TOOLS.has(unqualify(toolName));
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Serialize async work onto a promise chain.
 *
 * `runAgenticTurn` ran approvals in a dedicated serial phase *before*
 * dispatching tools in parallel, because two y/N questions cannot interleave
 * on one readline interface. The Agent SDK owns dispatch and may invoke
 * `canUseTool` concurrently, so that guarantee has to be rebuilt here — this
 * is the one piece of the hand-rolled loop that does not simply disappear.
 */
function makeSerializer() {
  let tail: Promise<unknown> = Promise.resolve();
  return function serialize<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto both settle paths so one rejection cannot wedge the queue.
    const run = tail.then(fn, fn);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}

/**
 * The interactive approval gate — the `approveMutating` hook's replacement.
 *
 * Note this is only half the mechanism: a tool listed in `allowedTools` is
 * auto-approved and **never reaches `canUseTool`** at all. The `PreToolUse`
 * hook in `hooks.ts` forces `permissionDecision: "ask"` for mutating tools so
 * this always runs; keeping mutating names out of `allowedTools` is the
 * second belt.
 */
export function buildCanUseTool(rlRef: RlRef): CanUseTool {
  const serialize = makeSerializer();

  return async (toolName, input) => {
    if (!isMutatingAgentTool(toolName)) {
      // `updatedInput` is required on an allow result.
      return { behavior: "allow", updatedInput: input };
    }

    const rl = rlRef.current;
    if (!rl) {
      // `bun run dev` throws here, killing the turn. A deny is strictly better:
      // the model gets a reason and can respond, and the same contract
      // ("mutating tools need a TTY") is preserved.
      return {
        behavior: "deny",
        message: `mutating tool '${unqualify(toolName)}' requires an interactive TTY for approval; not available in --once or piped mode`,
      };
    }

    const approved = await serialize(async () => {
      const answer = (
        await rl.question(
          `approve ${unqualify(toolName)}(${compactJson(input)})? [y/N] `,
        )
      )
        .trim()
        .toLowerCase();
      return answer === "y" || answer === "yes";
    });

    return approved
      ? {
          behavior: "allow",
          updatedInput: input,
          decisionClassification: "user_temporary",
        }
      : {
          behavior: "deny",
          message: "user denied execution of this tool call",
          decisionClassification: "user_reject",
        };
  };
}
