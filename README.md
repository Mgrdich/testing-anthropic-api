# testing-anthropic

A minimal TypeScript CLI for poking at the Anthropic API. Built on Bun (TS runs natively, no build step in dev) with the official `@anthropic-ai/sdk`.

## Setup

```bash
bun install
cp .env.example .env
# edit .env and paste your real ANTHROPIC_API_KEY
```

Bun auto-loads `.env`, so no `dotenv` import is needed.

## Usage

Running in a terminal drops you into a conversational REPL that keeps the
full message history across turns. Piping input keeps the old single-shot
behavior.

```bash
# interactive chat (empty line, 'exit', or Ctrl+D to quit)
bun run dev

# kick off the chat with an opening prompt
bun run dev "Say hello in one sentence."

# pick a model (defaults to claude-sonnet-4-6)
bun run dev --model claude-haiku-4-5-20251001

# set a system prompt and max tokens
bun run dev --system "You are terse." --max-tokens 256

# tune sampling temperature (0 = deterministic, 1 = creative)
bun run dev --temperature 0.2 "give me the same answer every time"

# load a long system prompt from a file (see system-prompts/)
bun run dev --system "$(cat system-prompts/math-tutor.txt)"

# force single-shot in a terminal (skip the REPL, exit after one reply)
bun run dev --once "what is 2+2?"

# debug: dump request config + response usage to stderr (stdout stays clean)
bun run dev --debug "hello"
bun run dev --debug "hello" 2>debug.log    # separate stream into a file

# stream the response token-by-token instead of waiting for the full reply
bun run dev --stream "write me a short poem about debugging"

# single-shot via stdin pipe (no REPL — exits after one reply)
echo "summarize: hello world" | bun run dev

# help
bun run dev --help
```

## Build a standalone bundle

```bash
bun run build      # writes dist/index.js
bun run start "hi" # runs the bundled output
```

## Flags

| Flag             | Default             | Description                                          |
|------------------|---------------------|------------------------------------------------------|
| `--model <id>`   | `claude-sonnet-4-6` | Any Anthropic model id.                              |
| `--system <txt>` | (none)              | System prompt.                                       |
| `--max-tokens N` | `1024`              | Max tokens in the response.                          |
| `--temperature N`| (model default)     | Sampling temperature, `0`–`1`.                       |
| `--once`         | off                 | Exit after the first reply (skip REPL even in TTY).  |
| `--debug`        | off                 | Log request config + response metadata to stderr.    |
| `--stream`       | off                 | Stream the response, printing tokens as they arrive. |
| `--help`         | —                   | Print usage and exit.                                |

## Project layout

```
src/
├── index.ts          # thin entry → calls runCli()
├── cli/              # terminal concerns
│   ├── index.ts      # runCli(): args, env, client, initial turn, REPL
│   ├── args.ts       # parseArgs, printHelp
│   ├── repl.ts       # runRepl(), sendTurn() — the conversation loop
│   └── stdin.ts      # readStdin() for piped input
└── core/             # Anthropic client + message orchestration
    ├── index.ts      # public barrel
    ├── messages.ts   # addUserMessage, addAssistantMessage, streamAssistantMessage, MessageParam
    └── constants.ts  # DEFAULT_MODEL, DEFAULT_MAX_TOKENS
```

`cli/` is everything that's specific to being a terminal program. `core/` is
the LLM-facing piece and is where future tool / MCP integrations will plug
in, so they can be reused by non-CLI callers too.

## Notes

- Requires Bun >= 1.1. Install on macOS with `brew install oven-sh/bun/bun`.
- TS strict mode is on; run `bun run typecheck` to verify types without emitting.
