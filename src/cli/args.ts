import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";

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
  prefill?: string;
  stopSequences?: string[];
  tools?: "all" | string[];
  maxIterations?: number;
  runner?: "local" | "sdk";
  mcp: boolean;
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
  --prefill <text>    Assistant prefill — model continues from this text
  --stop <seq>        Stop sequence (repeatable, max 4 per API)
  --tools [names]     Enable tool-use. Bare flag enables all built-in tools
                      (echo, get_time, calculator, get_weather); pass a
                      comma-separated subset, e.g. --tools calculator,get_time
  --max-iterations N  Cap the tool-use loop at N assistant turns (default:
                      unbounded). When the cap is hit, the loop returns the
                      last assistant message without dispatching its tools.
  --runner <name>     Pick the tool-use loop: 'local' (default) uses our
                      hand-rolled runAgenticTurn; 'sdk' uses Anthropic's
                      client.beta.messages.toolRunner.
  --mcp               Spawn the bundled MCP server (stdio) and expose its
                      tools to the model. Combines with --tools; alone, it
                      enables the agentic loop with MCP tools only. In the
                      REPL: /prompts lists MCP prompts, /<name> key=value
                      invokes one, and @<resource> (a docs/ file, e.g.
                      @northvale-tunnel-collapse.md or a docs:// URI)
                      attaches it to the turn.
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
    mcp: false,
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
      case "--mcp":
        out.mcp = true;
        break;
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
          throw new Error(`--max-iterations must be a positive integer (got ${v})`);
        }
        out.maxIterations = n;
        break;
      }
      case "--runner": {
        const v = argv[++i];
        if (v !== "local" && v !== "sdk") {
          throw new Error(`--runner must be 'local' or 'sdk' (got ${v ?? "<missing>"})`);
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
          out.tools = list;
        }
        break;
      }
      default:
        if (a !== undefined && a.startsWith("--")) {
          throw new Error(`Unknown option: ${a}`);
        }
        if (a !== undefined) positional.push(a);
    }
  }

  if (positional.length > 0) out.prompt = positional.join(" ");
  return out;
}
