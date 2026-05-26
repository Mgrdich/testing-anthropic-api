import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";

export type Args = {
  model: string;
  maxTokens: number;
  system?: string;
  prompt?: string;
  help: boolean;
  once: boolean;
};

export function printHelp(): void {
  process.stdout.write(
    `Usage: testing-anthropic [options] [prompt]

In a TTY, starts a conversational REPL that preserves message history across
turns. An optional positional prompt seeds the first turn. With piped stdin
(non-TTY), runs single-shot: reads stdin, prints one reply, exits.

Options:
  --model <id>        Model id (default: ${DEFAULT_MODEL})
  --system <text>     System prompt
  --max-tokens <n>    Max tokens in response (default: ${DEFAULT_MAX_TOKENS})
  --once              Exit after the first reply (skip the REPL even in a TTY)
  -h, --help          Show this help

Environment:
  ANTHROPIC_API_KEY   Required. Loaded from .env automatically by Bun.
`,
  );
}

export function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    help: false,
    once: false,
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
