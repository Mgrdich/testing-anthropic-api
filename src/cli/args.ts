import { MENTION_PREFIX, PROMPT_PREFIX } from "@/cli/mcp-turn.ts";
import {
  ADVISOR_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
} from "@/core/constants.ts";
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

export type Args = {
  model: string;
  maxTokens: number;
  temperature?: number;
  system?: string;
  prompt?: string;
  help: boolean;
  once: boolean;
  debug: boolean;
  stream: boolean;
  thinking: boolean;
  cache: boolean;
  prefill?: string;
  stopSequences?: string[];
  tools?: "all" | BuiltinToolName[];
  maxIterations?: number;
  runner?: "local" | "sdk";
  mcp?: "all" | McpServerName[];
  /**
   * StreamableHTTP MCP endpoints (`--mcp-url`, repeatable). Merged into the
   * same connection list as `--mcp`; unlike it, nothing is spawned — these
   * servers are already running.
   */
  mcpUrls?: string[];
  /** Advisor model id when `--advisor` is set (bare flag = ADVISOR_MODEL). */
  advisor?: string;
  /**
   * Backing directory for the memory tool when `--memory` is set (bare flag
   * = DEFAULT_MEMORY_DIR). Presence of the field is what enables the tool.
   */
  memory?: string;
  /**
   * Programmatic tool calling: expose the selected tools to a code-execution
   * container instead of to the model directly. Local runner only.
   */
  ptc: boolean;
};

export function printHelp() {
  process.stdout.write(
    `Usage: testing-anthropic [options] [prompt]

In a TTY, starts a conversational REPL that preserves message history across
turns. An optional positional prompt seeds the first turn. With piped stdin
(non-TTY), runs single-shot: reads stdin, prints one reply, exits.

Options:
  --model <id>        Model id (default: ${DEFAULT_MODEL})
  --system <text>     System prompt
  --max-tokens <n>    Max tokens in response (default: ${DEFAULT_MAX_TOKENS})
  --temperature <n>   Sampling temperature, 0 (deterministic) to 1 (creative)
  --once              Exit after the first reply (skip the REPL even in a TTY)
  --debug             Log request config and response metadata to stderr
  --stream            Stream the response, printing tokens as they arrive
  --thinking          Adaptive thinking (thinking: {type:"adaptive"}). Thinking
                      renders to stderr with a dim [thinking] prefix; stdout
                      stays answer-only. Incompatible with --prefill. Thinking
                      and the answer share the --max-tokens cap, so raise it
                      (a warning fires at the ${DEFAULT_MAX_TOKENS} default).
  --cache             Prompt caching: top-level cache_control
                      {type:"ephemeral"} (auto-places the breakpoint on the
                      last cacheable block) + a per-turn stderr line
                      "[cache] read=… wrote=… uncached=…" from response usage.
                      The minimum cacheable prefix on ${DEFAULT_MODEL} is
                      ~1024 tokens — short prompts silently won't cache;
                      --mcp plus a @resource mention is the easy way to see
                      a hit. Works with both --runner values.
  --advisor [model]   Enable the server-side advisor tool (beta
                      advisor-tool-2026-03-01): the executor model can consult
                      a stronger advisor mid-turn, server-side. Bare flag uses
                      ${ADVISOR_MODEL}; pass a model id to override. Always
                      streams; the advice renders to stderr as "[advisor] …".
                      Ignores --prefill; cannot be combined with --tools,
                      --mcp/--mcp-url, or --memory.
  --memory [dir]      Enable the Anthropic-defined memory tool
                      (memory_20250818) over a local directory, so the model
                      can persist notes across turns and runs. Bare flag uses
                      ${DEFAULT_MEMORY_DIR}; pass a directory to override —
                      the value is consumed only when it looks like a path
                      (starts with '.', '/' or '~', or contains a '/').
                      Forces the tool-use loop on even without --tools, and
                      combines with --tools/--mcp. Cannot be combined with
                      --advisor.
  --prefill <text>    Assistant prefill — model continues from this text
  --stop <seq>        Stop sequence (repeatable, max 4 per API)
  --tools [names]     Enable tool-use. Bare flag enables all built-in tools
                      (echo, get_time, calculator, get_weather); pass a
                      comma-separated subset, e.g. --tools calculator,get_time
  --ptc               Programmatic tool calling: add the server-side
                      code_execution tool and mark every --tools entry
                      allowed_callers: ["code_execution_20260120"], so Claude
                      scripts them inside the container and only the script's
                      final output re-enters the context. Requires --tools.
                      Drops strict tool use (incompatible) and threads the
                      container id across rounds, treating pause_turn as
                      "resume". Local runner only: cannot be combined with
                      --mcp/--mcp-url, --runner sdk, or --advisor.
  --max-iterations N  Cap the tool-use loop at N assistant turns (default:
                      unbounded). When the cap is hit, the loop returns the
                      last assistant message without dispatching its tools.
  --runner <name>     Pick the tool-use loop: 'local' (default) uses our
                      hand-rolled runAgenticTurn; 'sdk' uses Anthropic's
                      client.beta.messages.toolRunner.
  --mcp [servers]     Spawn MCP servers (stdio) and expose their tools to the
                      model. Bare flag connects all registered servers (docs,
                      research); pass a comma-separated subset, e.g.
                      --mcp docs,research. Combines with --tools; alone, it
                      enables the agentic loop with MCP tools only. In the
                      REPL: ${PROMPT_PREFIX}prompts lists MCP prompts,
                      ${PROMPT_PREFIX}<name> key=value invokes one, and
                      ${MENTION_PREFIX}<resource> (a docs/ file, e.g.
                      ${MENTION_PREFIX}northvale-tunnel-collapse.md or a
                      docs:// URI) attaches it to the turn.
  --mcp-url <url>     Connect to an already-running MCP server over
                      StreamableHTTP (repeatable). Merges into the same
                      session as --mcp — same tools, ${PROMPT_PREFIX}prompts and
                      ${MENTION_PREFIX}mentions, same duplicate-name rules.
                      Start the bundled one with 'bun run mcp:http-server',
                      then --mcp-url http://localhost:3100/mcp
  -h, --help          Show this help

Environment:
  ANTHROPIC_API_KEY   Required. Loaded from .env automatically by Bun.
`,
  );
}

export function parseArgs(argv: readonly string[]) {
  const out: Args = {
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    help: false,
    once: false,
    debug: false,
    stream: false,
    thinking: false,
    cache: false,
    ptc: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
      case "--stream":
        out.stream = true;
        break;
      case "--thinking":
        out.thinking = true;
        break;
      case "--cache":
        out.cache = true;
        break;
      case "--ptc":
        out.ptc = true;
        break;
      case "--mcp": {
        // Same heuristic as --tools: consume the next arg only if it looks
        // like a server-name list (identifier chars + commas, no spaces), so
        // `--mcp "tell me about docs"` keeps the string as the prompt.
        const next = argv[i + 1];
        const looksLikeServerList =
          next !== undefined && /^[a-zA-Z_][a-zA-Z0-9_,-]*$/.test(next);
        if (!looksLikeServerList) {
          out.mcp = "all";
        } else {
          i++;
          const list = next
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (list.length === 0) {
            throw new Error("--mcp list must contain at least one server name");
          }
          out.mcp = list.map((name) => {
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
      case "--mcp-url": {
        const v = argv[++i];
        if (!v) throw new Error("--mcp-url requires a value");
        // Validate at parse time (fb9df26 convention): a typo'd URL should
        // fail before we open a session, not as an opaque fetch error.
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
      case "--advisor": {
        // Same "consume only if it looks like a value" heuristic as --tools /
        // --mcp, so `--advisor "review this"` keeps the string as the prompt.
        // Validation is deliberately loose (any model-id-shaped token is
        // accepted) — an unknown advisor model is the API's 400 to explain.
        const next = argv[i + 1];
        const looksLikeModelId =
          next !== undefined && /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(next);
        if (!looksLikeModelId) {
          out.advisor = ADVISOR_MODEL;
        } else {
          i++;
          out.advisor = next;
        }
        break;
      }
      case "--memory": {
        // Same "consume only if it looks like a value" heuristic as --tools /
        // --mcp / --advisor, tuned for directories: the next arg is taken as
        // the memory dir only when it reads as a path (leading '.', '/' or
        // '~', or an embedded '/'). A bare word or a sentence stays the
        // prompt, so `--memory "what do you remember?"` does what you'd
        // expect.
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
      case "--model": {
        const v = argv[++i];
        if (!v) throw new Error("--model requires a value");
        out.model = v;
        break;
      }
      case "--system": {
        const v = argv[++i];
        if (!v) throw new Error("--system requires a value");
        out.system = v;
        break;
      }
      case "--max-tokens": {
        const v = argv[++i];
        if (!v) throw new Error("--max-tokens requires a value");
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--max-tokens must be a positive integer (got ${v})`);
        }
        out.maxTokens = n;
        break;
      }
      case "--temperature": {
        const v = argv[++i];
        if (!v) throw new Error("--temperature requires a value");
        const n = Number.parseFloat(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new Error(
            `--temperature must be a number between 0 and 1 (got ${v})`,
          );
        }
        out.temperature = n;
        break;
      }
      case "--prefill": {
        const v = argv[++i];
        if (v === undefined) throw new Error("--prefill requires a value");
        out.prefill = v;
        break;
      }
      case "--stop": {
        const v = argv[++i];
        if (v === undefined) throw new Error("--stop requires a value");
        (out.stopSequences ??= []).push(v);
        break;
      }
      case "--max-iterations": {
        const v = argv[++i];
        if (!v) throw new Error("--max-iterations requires a value");
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(
            `--max-iterations must be a positive integer (got ${v})`,
          );
        }
        out.maxIterations = n;
        break;
      }
      case "--runner": {
        const v = argv[++i];
        if (v !== "local" && v !== "sdk") {
          throw new Error(
            `--runner must be 'local' or 'sdk' (got ${v ?? "<missing>"})`,
          );
        }
        out.runner = v;
        break;
      }
      case "--tools": {
        // Only consume the next arg if it looks like a tool list (identifier
        // chars + commas, no spaces). Otherwise --tools is bare and the next
        // arg is the prompt, so `--tools "hello world"` does what you'd expect.
        const next = argv[i + 1];
        const looksLikeToolList =
          next !== undefined && /^[a-zA-Z_][a-zA-Z0-9_,-]*$/.test(next);
        if (!looksLikeToolList) {
          out.tools = "all";
        } else {
          i++;
          const list = next
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (list.length === 0) {
            throw new Error("--tools list must contain at least one tool name");
          }
          out.tools = list.map((name) => {
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
      default:
        if (a?.startsWith("--")) {
          throw new Error(`Unknown option: ${a}`);
        }
        if (a !== undefined) positional.push(a);
    }
  }

  if (positional.length > 0) out.prompt = positional.join(" ");

  if (out.thinking && out.prefill !== undefined) {
    throw new Error(
      "--thinking cannot be combined with --prefill (assistant prefill is rejected when thinking is enabled)",
    );
  }
  // Checked before the advisor rule so a `--ptc --advisor` combination gets
  // the PTC-specific message rather than the generic advisor one.
  if (out.ptc) {
    // Programmatic tool calling is the one non-composing flag in this CLI.
    // Each exclusion below is an API or architectural constraint, not taste:
    if (out.mcp || out.mcpUrls) {
      // The API rejects MCP tools alongside the code-execution tool — which
      // transport they arrived over makes no difference.
      throw new Error(
        "PTC is incompatible with MCP tools (--ptc with --mcp/--mcp-url)",
      );
    }
    if (out.runner === "sdk") {
      // toolRunner ends the loop on pause_turn instead of resuming, so a
      // paused container turn would silently return a truncated answer.
      throw new Error(
        "--ptc requires the local runner (toolRunner cannot auto-resume pause_turn)",
      );
    }
    if (out.advisor !== undefined) {
      // The advisor path is a plain streaming turn outside the agentic loop.
      throw new Error("--ptc cannot be combined with --advisor");
    }
    if (!out.tools) {
      // Without client-side tools there is nothing for the container to
      // script — the request would degenerate to plain code execution.
      throw new Error("--ptc requires --tools (the tools the container calls)");
    }
  }
  if (
    out.advisor !== undefined &&
    (out.tools || out.mcp || out.mcpUrls || out.memory !== undefined)
  ) {
    // v1 scope: the advisor path is a plain streaming turn with one
    // server-side tool, not the agentic loop — mixing it with client-side
    // tools would need the tool declaration threaded through every round.
    // `--memory` counts because it forces the agentic branch on its own.
    throw new Error(
      "--advisor cannot be combined with --tools, --mcp/--mcp-url, or --memory (the advisor tool runs server-side, outside the agentic loop)",
    );
  }
  if (out.thinking && out.maxTokens <= DEFAULT_MAX_TOKENS) {
    // max_tokens caps thinking + answer together; at the default the answer
    // can be squeezed out entirely. Warn rather than error — short thinking
    // runs are still legitimate.
    process.stderr.write(
      `warning: --thinking shares the max_tokens cap (${out.maxTokens}) with the answer; consider raising --max-tokens\n`,
    );
  }

  return out;
}
