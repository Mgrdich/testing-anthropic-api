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

# pin output shape with an assistant prefill (the model continues from this
# text) and bound the output with --stop. NOTE: claude-sonnet-4-6 does NOT
# support assistant prefill — use a prefill-capable model like haiku-4-5.
bun run dev --model claude-haiku-4-5-20251001 \
  --prefill '{' --stop '}' "give me a tiny JSON object about Paris"

# --stop alone works on any model; repeat the flag for multiple stops (max 4)
bun run dev --stop 'STOP' --stop 'END' "write a sentence then say STOP"

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
| `--prefill <txt>`| (none)              | Assistant prefill — model continues from this text.  |
| `--stop <seq>`   | (none)              | Stop sequence; repeat for multiple (max 4 per API).  |
| `--help`         | —                   | Print usage and exit.                                |

## Prompt evaluation workflow

`bun run eval` exposes a minimal end-to-end loop for iterating on a
prompt: scaffold a prompt directory, generate a dataset with Haiku,
run a prompt version against the dataset, grade with a code check
and/or a model judge, then combine the scores into a single 1-5
summary. Artifacts live under `evals/` and are checked in so versions
can be diffed.

**Caching contract:** `gen`, `run`, `code`, and `grade` all treat
their output file as a cache — re-running with the same `<name>
<version>` returns the prior result without API calls. `--force`
busts the cache. `combined` makes no API calls regardless and has
no `--force`; pass `--force` to the upstream commands instead.

```bash
# create evals/prompts/<name>/ with template files
bun run eval scaffold answer-question
bun run eval scaffold city-json --check zod

# generate a dataset (Haiku)
bun run eval gen answer-question --count 10

# run a prompt version against the dataset
bun run eval run answer-question v1

# code grader (skipped if no code-eval.ts)
bun run eval code city-json v1

# LLM-as-judge grader
bun run eval grade answer-question v1

# combine code+model into one score; --markdown writes a summary report
bun run eval combined city-json v1 --markdown

# one-shot: --auto runs any missing upstream artifacts first
bun run eval combined city-json v1 --auto --markdown

# iterate: write v2.txt, repeat run + grade [+ combined]
```

### Subcommands

| Command                                | Flags                                                         | What it does                       |
|----------------------------------------|---------------------------------------------------------------|------------------------------------|
| `eval scaffold <name>`                 | `--check <json\|zod\|regex\|none>` (default `none`)           | Create the prompt directory with template files. |
| `eval gen <name>`                      | `--count <N>` (default `10`), `--force`                       | Generate `evals/datasets/<name>.jsonl` using Haiku. `--force` overwrites. |
| `eval run <name> <version>`            | `--model <id>` (default `claude-sonnet-4-6`), `--force`       | Run the prompt against the dataset; write `<version>.runs.jsonl`. Cached unless `--force`. |
| `eval code <name> <version>`           | `--force`                                                     | Apply `code-eval.ts` to the runs; write `<version>.code.jsonl`. No-op if no `code-eval.ts`. Cached unless `--force`. |
| `eval grade <name> <version>`          | `--model <id>` (default `claude-sonnet-4-6`), `--force`       | LLM-as-judge over the runs; write `<version>.graded.jsonl`. Cached unless `--force`. |
| `eval combined <name> <version>`       | `--weights <c,m>` (default `0.5,0.5`), `--markdown`, `--auto` | Join `<version>.code.jsonl` and/or `<version>.graded.jsonl` into a single 1-5 score; write `<version>.combined.jsonl` (+ `.md` with `--markdown`). `--auto` bootstraps missing upstream artifacts (`run`, `code`, `grade`) before combining. Without `--auto`, no API calls. |

### `--check` template values

| Value   | Effect                                                                                           |
|---------|--------------------------------------------------------------------------------------------------|
| `none`  | No `code-eval.ts` written. Model grader only.                                                    |
| `json`  | Starter checks `JSON.parse(output)`. Score 1.0 on success, 0.0 with the parse error.             |
| `zod`   | Starter does `JSON.parse` + Zod schema validation. Edit the placeholder schema in `code-eval.ts`. |
| `regex` | Starter checks `new RegExp(output)` compiles.                                                    |

The starter is just a head start — `code-eval.ts` is a normal TS module
with `export const check: CheckFn`, so it can be rewritten to do anything
deterministic. See `src/eval/CLAUDE.md` for the full code-eval contract,
the `CheckResult` schema, and helpers (`zodCheck`, `stripCodeFence`,
`allChecks`).

## Project layout

```
src/
├── index.ts          # thin entry → calls runCli()
├── cli/              # chat-CLI concerns
│   ├── index.ts      # runCli(): args, env, initial turn, REPL
│   ├── args.ts       # parseArgs, printHelp
│   ├── repl.ts       # runRepl(), sendTurn() — the conversation loop
│   └── stdin.ts      # readStdin() for piped input
├── core/             # Anthropic client + message orchestration
│   ├── index.ts      # public barrel
│   ├── client.ts     # AnthropicClient singleton (init/get/reset)
│   ├── messages.ts   # addUserMessage, addAssistantMessage, streamAssistantMessage, MessageParam
│   ├── constants.ts  # DEFAULT_MODEL, DEFAULT_MAX_TOKENS
│   └── util.ts       # errMsg helper
└── eval/             # prompt evaluation module (`bun run eval`)
    ├── CLAUDE.md     # workflow docs + code-eval contract
    ├── index.ts      # public barrel — helper kit + types
    ├── cli.ts        # subcommand dispatcher
    ├── types.ts      # Zod schemas + inferred TS types
    └── …             # paths, jsonl, scaffold, dataset, runner, graders, checks
```

`cli/` is everything that's specific to being a terminal program. `core/`
is the LLM-facing piece (singleton client + message helpers) and is where
future tool / MCP integrations will plug in, so they can be reused by
non-CLI callers too. `eval/` is the prompt-evaluation module on top of
`core/`.

## Notes

- Requires Bun >= 1.1. Install on macOS with `brew install oven-sh/bun/bun`.
- TS strict mode is on; run `bun run typecheck` to verify types without emitting.
