import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { isMutatingAgentTool } from "@/agent/approve.ts";
import { Debug } from "@/core/index.ts";

const dbg = Debug.get();

/** Basename check for `.env` / `.env.local` / … */
function isEnvFile(filePath: string) {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  return base === ".env" || base.startsWith(".env.");
}

/**
 * The policy layer, in-process.
 *
 * Two jobs:
 *
 * 1. **Force the approval gate to run.** A tool that is auto-approved (by
 *    `allowedTools`, by permission mode, or by a settings rule) never reaches
 *    `canUseTool`. Returning `permissionDecision: "ask"` for mutating tools
 *    guarantees the y/N prompt in `approve.ts` is reached regardless.
 * 2. **Block `.env` reads** — a TypeScript port of
 *    `.claude/hooks/block-env-read.sh`, with no `jq` dependency. Only
 *    reachable under `--builtins`, since without Claude Code's own tools there
 *    is no `Read`/`Grep` to intercept.
 */
export function buildAgentHooks(opts: {
  builtinsEnabled: boolean;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            if (input.hook_event_name !== "PreToolUse") {
              return { continue: true };
            }
            dbg.json("pre tool use", () => ({
              tool: input.tool_name,
              input: input.tool_input,
              agent: input.agent_id ?? "main",
            }));

            if (
              opts.builtinsEnabled &&
              (input.tool_name === "Read" || input.tool_name === "Grep")
            ) {
              const target = input.tool_input as {
                file_path?: string;
                path?: string;
              };
              const filePath = target.file_path ?? target.path ?? "";
              if (isEnvFile(filePath)) {
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason:
                      "Reading .env files is blocked — they hold secrets.",
                  },
                };
              }
            }

            if (isMutatingAgentTool(input.tool_name)) {
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "ask",
                  permissionDecisionReason:
                    "mutating tool requires interactive approval",
                },
              };
            }

            return { continue: true };
          },
        ],
      },
    ],
  };
}
