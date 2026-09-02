import type {
  EffortLevel,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MODEL } from "@/core/constants.ts";
import {
  BUILTIN_TOOLS,
  type BuiltinToolName,
  DEFAULT_MEMORY_DIR,
  isBuiltinToolName,
} from "@/core/index.ts";
import {
  isMcpServerName,
  MCP_SERVERS,
  type McpServerName,
} from "@/mcp/index.ts";

export type AgentArgs = {
  model: string;
  system?: string;
  prompt?: string;
  help: boolean;
  once: boolean;
  debug: boolean;
  sdkDebug: boolean;
  thinking: boolean;
  cache: boolean;
  effort?: EffortLevel;
  tools?: "all" | BuiltinToolName[];
  memory?: string;
  mcp?: "all" | McpServerName[];
  mcpUrls?: string[];
  /** Expose Claude Code's own built-in tools (Read/Write/Bash/…). */
  builtins: boolean;
  /** Use the full Claude Code system prompt instead of the SDK's minimal one. */
  claudeCodePrompt: boolean;
  /** Load ~/.claude and repo settings instead of running hermetically. */
  inheritSettings: boolean;
  fallbackModel?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: PermissionMode;
  resume?: string;
  continueSession: boolean;
  fork: boolean;
  persist: boolean;
};

/**
 * Flags that exist on `bun run dev` but have **no Agent SDK expression**.
 * Rejecting them by name with a pointer beats accepting and silently ignoring
 * them — see `src/agent/CLAUDE.md` for why each one cannot port.
 */
const UNSUPPORTED: Record<string, string> = {
  "--prefill":
    "assistant prefill has no Agent SDK surface (query() drives a CLI turn loop, not messages.create)",
  "--stop": "stop sequences are not exposed by the Agent SDK",
  "--temperature": "sampling parameters are not exposed by the Agent SDK",
  "--max-tokens":
    "the Agent SDK has no max_tokens; use --max-turns or --max-budget-usd",
  "--advisor": "the server-side advisor tool is not configurable via the SDK",
  "--ptc": "programmatic tool calling has no Agent SDK surface",
  "--runner": "there is only one loop here — that is the point of this CLI",
  "--stream": "streaming is always on (includePartialMessages)",
};

export function printAgentHelp() {
  process.stdout.write(
    `Usage: bun run agent-sdk [options] [prompt]

The same conversational CLI as 'bun run dev', rebuilt on Anthropic's Claude
Agent SDK (@anthropic-ai/claude-agent-sdk). The agentic loop, tool dispatch,
MCP connection management, and conversation history are all owned by the SDK;
this CLI only assembles options and renders the message stream.

In a TTY, starts a REPL. With piped stdin (non-TTY) or --once, runs one turn.

Options:
  --model <id>          Model id (default: ${DEFAULT_MODEL})
  --fallback-model <id> Model(s) to fall back to when the primary is
                        overloaded; comma-separated, tried in order.
  --system <text>       System prompt. Omitted, the SDK uses a minimal
                        tool-calling prompt (NOT the Claude Code prompt).
  --claude-code-prompt  Use the full Claude Code system prompt preset instead.
  --tools [names]       Enable our demo tools. Bare = all
                        (${Object.keys(BUILTIN_TOOLS).join(", ")});
                        or a comma-separated subset. They are exposed as an
                        in-process MCP server, so the model sees them as
                        mcp__builtins__<name>.
  --memory [dir]        Enable the memory tool over a local directory
                        (default: ${DEFAULT_MEMORY_DIR}). Reuses the same
                        filesystem backend and containment checks as
                        'bun run dev --memory', but under a hand-written
                        schema (memory_20250818 has no SDK surface).
  --mcp [servers]       Spawn MCP servers over stdio. Bare = all
                        (${Object.keys(MCP_SERVERS).join(", ")}); or a subset.
                        The SDK owns connect/convert/reconnect/close.
  --mcp-url <url>       Connect to a running StreamableHTTP MCP server
                        (repeatable). Start one with 'bun run mcp:http-server'.
  --builtins            Also expose Claude Code's own tools (Read, Write, Edit,
                        Bash, Glob, Grep, …). Off by default so this stays a
                        demo of our tools rather than a coding agent.
  --thinking            Adaptive extended thinking; renders to stderr with a
                        dim [thinking] prefix. No max-tokens budget to share.
  --effort <level>      low | medium | high | xhigh | max
  --cache               Print a per-turn [cache] line from the result's
                        modelUsage. NOTE: breakpoint placement is the SDK's
                        business now — this flag is observability only.
  --max-turns <n>       Cap conversation turns (SDK maxTurns). Not the same
                        unit as 'bun run dev --max-iterations'.
  --max-budget-usd <n>  Stop the turn once it has cost more than <n> USD.
  --permission-mode <m> default | acceptEdits | plan | dontAsk | auto
  --resume <id>         Resume a stored session by id.
  --continue            Resume the most recent session in this directory.
  --fork                With --resume, branch into a new session id.
  --no-persist          Do not write the session to ~/.claude/projects/.
  --inherit-settings    Load ~/.claude and repo settings/CLAUDE.md. Off by
                        default so behavior does not depend on the machine.
  --once                Exit after the first reply (skip the REPL in a TTY)
  --debug               Trace to stderr (our Debug singleton + SDK stderr)
  --sdk-debug           Also enable the SDK's own verbose logging (noisy)
  -h, --help            Show this help

Not supported here — these still work on 'bun run dev':
  --prefill, --stop, --temperature, --max-tokens, --advisor, --ptc, --runner
  Each is a raw Messages API capability the Agent SDK does not expose.

Environment:
  ANTHROPIC_API_KEY   Required. Loaded from .env automatically by Bun and
                      inherited by the SDK's subprocess.
`,
  );
}

/**
 * Shared "consume the next arg only if it looks like a value" heuristic, so
 * `--tools "hello world"` keeps the string as the prompt. Same convention as
 * `src/cli/args.ts`.
 */
function looksLikeNameList(next: string | undefined): next is string {
  return next !== undefined && /^[a-zA-Z_][a-zA-Z0-9_,-]*$/.test(next);
}

function splitList(value: string, flag: string) {
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) {
    throw new Error(`${flag} list must contain at least one name`);
  }
  return list;
}

export function parseAgentArgs(argv: readonly string[]) {
  const out: AgentArgs = {
    model: DEFAULT_MODEL,
    help: false,
    once: false,
    debug: false,
    sdkDebug: false,
    thinking: false,
    cache: false,
    builtins: false,
    claudeCodePrompt: false,
    inheritSettings: false,
    continueSession: false,
    fork: false,
    persist: true,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a !== undefined && a in UNSUPPORTED) {
      throw new Error(
        `${a} is not supported by the agent CLI: ${UNSUPPORTED[a]}. It still works on 'bun run dev'.`,
      );
    }

    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--once":
        out.once = true;
        break;
      case "--debug":
        out.debug = true;
        break;
      case "--sdk-debug":
        out.sdkDebug = true;
        break;
      case "--thinking":
        out.thinking = true;
        break;
      case "--cache":
        out.cache = true;
        break;
      case "--builtins":
        out.builtins = true;
        break;
      case "--claude-code-prompt":
        out.claudeCodePrompt = true;
        break;
      case "--inherit-settings":
        out.inheritSettings = true;
        break;
      case "--continue":
        out.continueSession = true;
        break;
      case "--fork":
        out.fork = true;
        break;
      case "--no-persist":
        out.persist = false;
        break;
      case "--model": {
        const v = argv[++i];
        if (!v) throw new Error("--model requires a value");
        out.model = v;
        break;
      }
      case "--fallback-model": {
        const v = argv[++i];
        if (!v) throw new Error("--fallback-model requires a value");
        out.fallbackModel = v;
        break;
      }
      case "--system": {
        const v = argv[++i];
        if (!v) throw new Error("--system requires a value");
        out.system = v;
        break;
      }
      case "--resume": {
        const v = argv[++i];
        if (!v) throw new Error("--resume requires a value");
        out.resume = v;
        break;
      }
      case "--effort": {
        const v = argv[++i];
        if (
          v !== "low" &&
          v !== "medium" &&
          v !== "high" &&
          v !== "xhigh" &&
          v !== "max"
        ) {
          throw new Error(
            `--effort must be low|medium|high|xhigh|max (got ${v ?? "<missing>"})`,
          );
        }
        out.effort = v;
        break;
      }
      case "--permission-mode": {
        const v = argv[++i];
        if (
          v !== "default" &&
          v !== "acceptEdits" &&
          v !== "plan" &&
          v !== "dontAsk" &&
          v !== "auto"
        ) {
          // `bypassPermissions` is deliberately omitted: it additionally
          // requires allowDangerouslySkipPermissions, and this CLI has no
          // reason to hand out that footgun.
          throw new Error(
            `--permission-mode must be default|acceptEdits|plan|dontAsk|auto (got ${v ?? "<missing>"})`,
          );
        }
        out.permissionMode = v;
        break;
      }
      case "--max-turns": {
        const v = argv[++i];
        if (!v) throw new Error("--max-turns requires a value");
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--max-turns must be a positive integer (got ${v})`);
        }
        out.maxTurns = n;
        break;
      }
      case "--max-budget-usd": {
        const v = argv[++i];
        if (!v) throw new Error("--max-budget-usd requires a value");
        const n = Number.parseFloat(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(
            `--max-budget-usd must be a positive number (got ${v})`,
          );
        }
        out.maxBudgetUsd = n;
        break;
      }
      case "--mcp-url": {
        const v = argv[++i];
        if (!v) throw new Error("--mcp-url requires a value");
        // Validate at parse time so a typo'd URL fails before we spawn the
        // SDK subprocess, not as an opaque connection error inside it.
        let parsed: URL;
        try {
          parsed = new URL(v);
        } catch {
          throw new Error(`--mcp-url: not a valid URL (got ${v})`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error(
            `--mcp-url must be http(s) (got ${parsed.protocol}//…)`,
          );
        }
        (out.mcpUrls ??= []).push(parsed.href);
        break;
      }
      case "--tools": {
        const next = argv[i + 1];
        if (!looksLikeNameList(next)) {
          out.tools = "all";
        } else {
          i++;
          out.tools = splitList(next, "--tools").map((name) => {
            if (!isBuiltinToolName(name)) {
              const known = Object.keys(BUILTIN_TOOLS).join(", ");
              throw new Error(
                `--tools: unknown tool '${name}' (known: ${known})`,
              );
            }
            return name;
          });
        }
        break;
      }
      case "--mcp": {
        const next = argv[i + 1];
        if (!looksLikeNameList(next)) {
          out.mcp = "all";
        } else {
          i++;
          out.mcp = splitList(next, "--mcp").map((name) => {
            if (!isMcpServerName(name)) {
              const known = Object.keys(MCP_SERVERS).join(", ");
              throw new Error(
                `--mcp: unknown server '${name}' (known: ${known})`,
              );
            }
            return name;
          });
        }
        break;
      }
      case "--memory": {
        // Path-shaped heuristic, same as `src/cli/args.ts`: a leading . / ~
        // or an embedded slash is a directory, anything else is the prompt.
        const next = argv[i + 1];
        const looksLikeDir =
          next !== undefined && /^(?:[.~/][^\s]*|[^\s]*\/[^\s]*)$/.test(next);
        if (!looksLikeDir) {
          out.memory = DEFAULT_MEMORY_DIR;
        } else {
          i++;
          out.memory = next;
        }
        break;
      }
      default:
        if (a?.startsWith("--")) {
          throw new Error(`Unknown option: ${a}`);
        }
        if (a !== undefined) positional.push(a);
    }
  }

  if (positional.length > 0) out.prompt = positional.join(" ");

  // Cross-flag validation lives after the loop so argv order cannot change
  // the outcome — same convention as `src/cli/args.ts`.
  if (out.fork && out.resume === undefined) {
    throw new Error("--fork requires --resume (there is nothing to fork from)");
  }
  if (out.continueSession && out.resume !== undefined) {
    throw new Error("--continue and --resume are mutually exclusive");
  }
  if (!out.persist && (out.resume !== undefined || out.continueSession)) {
    throw new Error(
      "--no-persist cannot be combined with --resume/--continue (an unpersisted session cannot be resumed)",
    );
  }

  return out;
}
