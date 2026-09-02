import {
  type Options,
  type Query,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { buildCanUseTool, type RlRef } from "@/agent/approve.ts";
import type { AgentArgs } from "@/agent/args.ts";
import { buildAgentHooks } from "@/agent/hooks.ts";
import { createInbox } from "@/agent/inbox.ts";
import { buildMcpServerConfigs } from "@/agent/mcp.ts";
import { createRenderer } from "@/agent/render.ts";
import { createBuiltinsServer } from "@/agent/tools/builtins.ts";
import { Debug } from "@/core/index.ts";

const dbg = Debug.get();

/**
 * Assemble `Options`. This is the `requestOpts` equivalent from
 * `src/cli/repl.ts` — except there is only one path now, so there are no
 * branches to hand it to.
 *
 * Three settings are load-bearing and non-obvious; see the comments inline.
 */
function buildOptions(args: AgentArgs, rlRef: RlRef): Options {
  const mcpServers = buildMcpServerConfigs(args);
  const hasExternalMcp = Object.keys(mcpServers).length > 0;

  if (args.tools !== undefined || args.memory !== undefined) {
    mcpServers.builtins = createBuiltinsServer({
      ...(args.tools !== undefined ? { tools: args.tools } : {}),
      ...(args.memory !== undefined ? { memoryDir: args.memory } : {}),
    });
  }

  // `allowedTools` is deliberately NOT set. A bare name there auto-approves
  // the tool *before* `canUseTool` is consulted — the SDK warns about exactly
  // this (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). Leaving it unset routes every
  // call through one decision point: `canUseTool` allows non-mutating tools
  // silently and prompts y/N for mutating ones, and the `PreToolUse` hook
  // forces "ask" so a settings rule cannot shadow the gate either.

  return {
    model: args.model,
    ...(args.fallbackModel !== undefined
      ? { fallbackModel: args.fallbackModel }
      : {}),

    // Omitting `systemPrompt` yields the SDK's MINIMAL tool-calling prompt,
    // not Claude Code's — which is what matches `bun run dev`'s default of no
    // system prompt at all. `--claude-code-prompt` opts into the real one.
    ...(args.claudeCodePrompt
      ? {
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            ...(args.system !== undefined ? { append: args.system } : {}),
          },
        }
      : args.system !== undefined
        ? { systemPrompt: args.system }
        : {}),

    // In 0.3.251 OMITTING this loads user + project + local settings, so the
    // agent would silently inherit ~/.claude/settings.json, this repo's
    // .claude/settings.json hooks, and this repo's CLAUDE.md — making the
    // demo's behavior depend on the developer's machine. Default to hermetic.
    settingSources: args.inheritSettings ? ["user", "project", "local"] : [],

    // `tools` gates AVAILABILITY of Claude Code's built-ins; `allowedTools`
    // only gates permission. `[]` keeps this a demo of *our* tools rather than
    // a coding agent. With MCP configured, allow just the two resource tools
    // so the model can reach MCP resources (the `@mention` replacement).
    tools: args.builtins
      ? { type: "preset", preset: "claude_code" }
      : hasExternalMcp
        ? ["ListMcpResourcesTool", "ReadMcpResourceTool"]
        : [],

    mcpServers,
    // Ignore .mcp.json, plugins, and on-disk agent frontmatter — only servers
    // this CLI asked for.
    strictMcpConfig: true,

    canUseTool: buildCanUseTool(rlRef),
    hooks: buildAgentHooks({ builtinsEnabled: args.builtins }),
    ...(args.permissionMode !== undefined
      ? { permissionMode: args.permissionMode }
      : {}),

    // Always on: the renderer's stdout path is built entirely on stream events,
    // so `--stream` has nothing left to toggle.
    includePartialMessages: true,

    // `display` is explicit for the same reason as `bun run dev`: it defaults
    // to "omitted" on 4.7+ models, where the blocks still arrive but with
    // empty text, so the [thinking] renderer would print a bare prefix.
    ...(args.thinking
      ? {
          thinking: {
            type: "adaptive" as const,
            display: "summarized" as const,
          },
        }
      : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
    ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
    ...(args.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: args.maxBudgetUsd }
      : {}),

    ...(args.resume !== undefined ? { resume: args.resume } : {}),
    ...(args.continueSession ? { continue: true } : {}),
    ...(args.fork ? { forkSession: true } : {}),
    ...(args.persist ? {} : { persistSession: false }),

    cwd: process.cwd(),

    // NEVER set `env`: unlike the Python SDK it REPLACES rather than merges,
    // which would drop PATH, HOME, and the ANTHROPIC_API_KEY that Bun's .env
    // autoload puts there. Leaving it unset is what lets auth work.

    // Silent unless --debug; the Debug singleton owns the enabled check.
    stderr: (data) => dbg.log(() => `[sdk] ${data.trimEnd()}`),
    ...(args.sdkDebug ? { debug: true, includeHookEvents: true } : {}),
  };
}

export type AgentSession = {
  /** Send one user turn and resolve when its `result` message arrives. */
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  close: () => Promise<void>;
  sessionId: () => string | undefined;
  handle: Query;
};

/**
 * Start one long-lived `query()` spanning every turn of the session.
 *
 * This is the whole port, structurally: `runAgenticTurn`'s loop, the
 * `stop_reason` polling, the round counting, the tool dispatch, and the
 * `messages: MessageParam[]` array are all gone. The transcript lives in the
 * SDK's subprocess (and on disk), which is what makes `--resume`/`--fork`
 * possible and why nothing here mutates conversation state.
 */
export function startAgentSession(args: AgentArgs, rlRef: RlRef): AgentSession {
  const inbox = createInbox();
  const renderer = createRenderer(args);
  const options = buildOptions(args, rlRef);
  dbg.json("agent options", () => ({
    ...options,
    // These carry live instances / closures that do not serialize usefully.
    canUseTool: undefined,
    hooks: undefined,
    stderr: undefined,
    mcpServers: Object.keys(options.mcpServers ?? {}),
  }));

  // `query()` returns synchronously; the subprocess spawns lazily.
  const q = query({ prompt: inbox.stream(), options });

  let sessionId: string | undefined;
  let fatal: unknown;

  /**
   * One deferred per in-flight turn, FIFO. A queue rather than a pair of
   * nullable callbacks: messages can be pushed onto the inbox faster than the
   * agent processes them, and `shift()` is naturally `T | undefined` so no
   * null-narrowing gymnastics are needed.
   */
  const waiters: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  const pump = (async () => {
    try {
      for await (const message of q) {
        if (message.session_id) sessionId = message.session_id;
        renderer.handle(message);
        if (message.type === "result") {
          // Only the turn promise settles here — `prompt_suggestion` and task
          // notifications can arrive AFTER a result, so the loop keeps going.
          waiters.shift()?.resolve();
        }
      }
      // The stream ended (close, or the subprocess exiting): nothing else will
      // settle these, so release anything still waiting rather than hanging.
      for (const waiter of waiters.splice(0)) {
        waiter.reject(
          new Error("agent session ended before the turn finished"),
        );
      }
    } catch (err) {
      fatal = err;
      for (const waiter of waiters.splice(0)) waiter.reject(err);
    }
  })();

  return {
    handle: q,
    sessionId: () => sessionId,

    async send(text) {
      if (fatal) throw fatal;
      const turn = new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
      inbox.push(text);
      await turn;
    },

    async interrupt() {
      await q.interrupt();
    },

    async close() {
      inbox.close();
      q.close();
      await pump;
    },
  };
}
