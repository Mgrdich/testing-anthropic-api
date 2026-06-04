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

# enable tool-use (all built-in demo tools)
bun run dev --tools "what time is it, and what is (12*7)+3?"

# enable a subset of tools
bun run dev --once --tools calculator "compute (2+3)*4"

# tool-use with full debug payloads (request/response/stream events plus
# agentic round, tool call, and tool result frames on stderr)
bun run dev --debug --tools "what's the weather in Paris?" 2>tools.log

# same prompt, but with Anthropic's official SDK toolRunner instead of
# our hand-rolled loop (same hooks/rendering, different loop internals)
bun run dev --tools --runner sdk "what time is it?"

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
| `--tools [names]`| off                 | Enable tool-use. Bare flag enables all built-ins; pass a comma-separated subset, e.g. `--tools calculator,get_time`. |
| `--max-iterations N` | unbounded       | Cap the tool-use loop at N assistant turns. When the cap fires, the REPL prints a warning and the model's last (unfinished) tool-call message is the final response. |
| `--runner <name>`| `local`             | Pick the tool-use loop: `local` is our hand-rolled `runAgenticTurn`; `sdk` is Anthropic's `client.beta.messages.toolRunner()` (beta API). |
| `--help`         | —                   | Print usage and exit.                                |

## Tools

The CLI ships with four demo tools — `echo`, `get_time`, `calculator`,
and `get_weather` (mocked). Enable them with `--tools`:

```bash
# all built-ins
bun run dev --tools "what time is it, and what is (12*7)+3?"

# subset
bun run dev --once --tools calculator "compute (2+3)*4"
```

Tool calls and results are printed to stderr (`[tool] name(input)` then
`  → name: result`); the final assistant text goes to stdout. When the
model calls multiple tools in one turn, approval prompts run serially
but execution runs concurrently via `Promise.all`. Cap the loop with
`--max-iterations N`. The tools path always streams and ignores
`--prefill`. To add a new tool — or to flag it as mutating (the REPL
prompts y/N before running, via the `MUTATING_TOOLS` set in
`builtins.ts`) — see `src/core/tools/CLAUDE.md`.

### Parallel tool calls in one turn

Parallel tool use is the Anthropic API's default — we send nothing to
enable it. The request payload (built in `core/tools/agentic.ts` and
dispatched in `core/messages.ts`) is just `{ model, max_tokens,
messages, tools }`; no `tool_choice`, no `disable_parallel_tool_use`.
The model is free to emit multiple `tool_use` blocks in a single
assistant response whenever the calls are independent, and the runner
executes them concurrently.

Ask for four independent things at once:

```bash
echo 'In a single response, please: (1) tell me the current time in UTC, \
(2) compute 17 * 23 + 4 with the calculator, (3) get the weather in Tokyo, \
and (4) get the weather in Paris. Call all four tools in parallel.' \
  | bun run dev --tools --debug 2>&1 \
  | awk '/\[debug\] agentic round/{f=1} f{print; if(/^}/){f=0; print "---"}} /^\[tool\]|^  [→✗]/{print}'
```

You should see one assistant turn with **four** `tool_use` blocks
(`tool_use_blocks: 4`), all `[tool]` lines fire before any results,
then a second turn that just wraps up with text:

```
[debug] agentic round {
  "iteration": 1,
  "stop_reason": "tool_use",
  "tool_use_blocks": 4
}
---
[tool] get_time({})
[tool] calculator({"expression":"17 * 23 + 4"})
[tool] get_weather({"city":"Tokyo"})
[tool] get_weather({"city":"Paris"})
  → get_time: 2026-06-04T16:22:14.355Z
  → calculator: 395
  → get_weather: {"city":"Tokyo","tempC":22,"condition":"sunny","note":"mocked data"}
  → get_weather: {"city":"Paris","tempC":22,"condition":"sunny","note":"mocked data"}
[debug] agentic round {
  "iteration": 2,
  "stop_reason": "end_turn",
  "tool_use_blocks": 0
}
---
```

Two API calls total, not five. `tool_use_blocks > 1` in a single round
is the unambiguous signal that the model batched the calls; the four
`[tool]` lines printing contiguously before any `→` result is the
two-phase dispatch (serial approval pass, then parallel `Promise.all`
execution) in `core/tools/agentic.ts:82-118`.

## Prompt evaluation workflow

`bun run eval` exposes a minimal end-to-end loop for iterating on a
prompt: scaffold a prompt directory, generate a dataset with Haiku,
run a prompt version against the dataset, grade with a code check
and/or a model judge, then combine the scores into a single 1-5
summary. Artifacts live under `evals/` and are checked in so versions
can be diffed.

**Caching contract:** every API-calling subcommand (`gen`, `run`,
`code`, `grade`) treats its output file as a cache — re-running
with the same `<name> <version>` returns the prior result without
API calls. `combined` uses mtime-aware caching: it short-circuits
only if `<version>.combined.jsonl` is newer than every input file
it would read, so re-running any upstream with `--force` naturally
invalidates it. `--force` on any subcommand busts the cache
unconditionally.

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

# iterate: write v2.txt next to v1.txt (judge.txt, generate.txt,
# code-eval.ts, and the dataset are shared across versions — only
# <version>.txt and its *.jsonl outputs are per-version)
bun run eval combined teacher-hinter v2 --auto --markdown
```

### Subcommands

| Command                                | Flags                                                         | What it does                       |
|----------------------------------------|---------------------------------------------------------------|------------------------------------|
| `eval scaffold <name>`                 | `--check <json\|zod\|regex\|none>` (default `none`)           | Create the prompt directory with template files. |
| `eval gen <name>`                      | `--count <N>` (default `10`), `--force`                       | Generate `evals/datasets/<name>.jsonl` using Haiku. `--force` overwrites. |
| `eval run <name> <version>`            | `--model <id>` (default `claude-sonnet-4-6`), `--force`       | Run the prompt against the dataset; write `<version>.runs.jsonl`. Cached unless `--force`. |
| `eval code <name> <version>`           | `--force`                                                     | Apply `code-eval.ts` to the runs; write `<version>.code.jsonl`. No-op if no `code-eval.ts`. Cached unless `--force`. |
| `eval grade <name> <version>`          | `--model <id>` (default `claude-sonnet-4-6`), `--force`       | LLM-as-judge over the runs; write `<version>.graded.jsonl`. Cached unless `--force`. |
| `eval combined <name> <version>`       | `--weights <c,m>` (default `0.5,0.5`), `--markdown`, `--auto`, `--force` | Join `<version>.code.jsonl` and/or `<version>.graded.jsonl` into a single 1-5 score; write `<version>.combined.jsonl` (+ `.md` with `--markdown`). `--auto` bootstraps missing upstream artifacts (`run`, `code`, `grade`) before combining. Cached when combined is newer than all its inputs; `--force` recomputes. Without `--auto`, no API calls. |

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
│   ├── util.ts       # errMsg helper
│   └── tools/            # tool-use: Tool type, per-tool files, runAgenticTurn loop
│       ├── CLAUDE.md
│       ├── index.ts
│       ├── types.ts      # Tool interface
│       ├── define.ts     # defineTool() — thin wrapper over SDK's betaZodTool
│       ├── echo.ts       # one file per built-in tool
│       ├── get_time.ts
│       ├── calculator.ts
│       ├── get_weather.ts
│       ├── builtins.ts   # BUILTIN_TOOLS registry + selectTools() + MUTATING_TOOLS
│       ├── agentic.ts    # runAgenticTurn (local hand-rolled loop)
│       └── agentic_sdk.ts # runAgenticTurnSdk (client.beta.messages.toolRunner)
└── eval/             # prompt evaluation module (`bun run eval`)
    ├── CLAUDE.md     # workflow docs + code-eval contract
    ├── index.ts      # public barrel — helper kit + types
    ├── cli.ts        # subcommand dispatcher
    ├── types.ts      # Zod schemas + inferred TS types
    └── …             # paths, jsonl, scaffold, dataset, runner, graders, checks
```

`cli/` is everything that's specific to being a terminal program. `core/`
is the LLM-facing piece (singleton client + message helpers + the
tool-use loop in `core/tools/`) and is where future MCP integration will
plug in too — so it can be reused by non-CLI callers. `eval/` is the
prompt-evaluation module on top of `core/`.

## Notes

- Requires Bun >= 1.1. Install on macOS with `brew install oven-sh/bun/bun`.
- TS strict mode is on; run `bun run typecheck` to verify types without emitting.
