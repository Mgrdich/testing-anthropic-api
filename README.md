# testing-anthropic

A minimal TypeScript CLI for poking at the Anthropic API. Built on Bun (TS runs natively, no build step in dev) with the official `@anthropic-ai/sdk`.

Beyond the chat CLI it carries four sub-CLIs, each exercising a different
slice of the API surface: `bun run eval` (prompt evaluation), `bun run rag`
(chunking + hybrid retrieval + cited answers), `bun run mcp` (Model Context
Protocol client/servers), and `bun run skills` (Agent Skills + Files API).

There is also a second chat CLI, `bun run agent-sdk`, which rebuilds the same
conversation on Anthropic's **Claude Agent SDK** — the agentic loop, tool
dispatch, MCP connections and history are the SDK's rather than hand-rolled.
It is additive: `bun run dev` is unchanged and keeps the request-shaping flags
the Agent SDK cannot express (`--prefill`, `--stop`, `--temperature`,
`--max-tokens`, `--advisor`, `--ptc`, cache-breakpoint placement, MCP
sampling). See [the Agent SDK CLI](#the-agent-sdk-cli-bun-run-agent-sdk) below
for when to use which, and `src/agent/CLAUDE.md` for the full comparison.

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

# adaptive thinking — reasoning renders to stderr, stdout stays answer-only
bun run dev --thinking --max-tokens 4096 "how many r's in strawberry?"

# prompt caching — prints [cache] read=… wrote=… uncached=… after each turn
bun run dev --cache --system "$(cat system-prompts/math-tutor.txt)" "hi"

# advisor tool: sonnet-4-6 executor consults an opus-4-8 advisor mid-turn
bun run dev --advisor "design a rate limiter for a multi-tenant API"

# memory tool — the model persists notes under ./memories across runs
bun run dev --memory "remember that I prefer TypeScript over Python"

# connect MCP servers over stdio (bare flag connects docs + research)
bun run dev --mcp "research the Eiffel Tower"

# ...or over StreamableHTTP (start the server first, see MCP section below)
bun run dev --mcp-url http://localhost:3100/mcp "list the docs"

# enable tool-use (all built-in demo tools)
bun run dev --tools "what time is it, and what is (12*7)+3?"

# programmatic tool calling — Claude scripts your tools inside the container
bun run dev --tools --ptc "what's the weather in Tokyo, Paris, and Lima?"

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

## The Agent SDK CLI (`bun run agent-sdk`)

`bun run dev` drives the raw Messages API and hand-rolls the agentic loop.
`bun run agent-sdk` is the **same conversation rebuilt on the Claude Agent
SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code packaged as a library.
`query()` spawns the bundled Claude Code binary as a subprocess and owns the
loop, tool dispatch, MCP connections, permissions, and conversation history.

**When to reach for which:**

| Use `bun run dev` when you want… | Use `bun run agent-sdk` when you want… |
|---|---|
| Request-level control: `--prefill`, `--stop`, `--temperature`, `--max-tokens`, explicit `cache_control` placement | The agentic loop handled for you — no `runAgenticTurn`, no round counting, no tool dispatch |
| Server-side features: `--advisor`, `--ptc` (programmatic tool calling), Message Batches | Durable sessions: `--resume`, `--continue`, `--fork` |
| MCP **sampling** (`bun run dev --mcp "research the Eiffel Tower"`) and deterministic `@resource` / `#prompt` handling | MCP servers wired by config alone — no connect/convert/close code |
| To see how the loop works | To see how little code an agent needs |

Neither replaces the other; the module is additive and `bun run dev` lost
nothing. The full port/lost table lives in `src/agent/CLAUDE.md`.

```bash
# interactive REPL (empty line, 'exit', or Ctrl+D to quit)
bun run agent-sdk

# kick off with an opening prompt
bun run agent-sdk "explain MCP in one sentence"

# single-shot via stdin pipe
echo "say hello" | bun run agent-sdk

# our four demo tools, exposed to the model as an in-process MCP server
# (the model sees them as mcp__builtins__calculator, etc.)
bun run agent-sdk --tools "what is (2+3)*4?"

# a subset
bun run agent-sdk --tools calculator,get_time "what time is it?"

# memory tool — same ./memories backend and containment checks as
# `bun run dev --memory`, under a hand-written schema
bun run agent-sdk --memory "remember that I prefer TypeScript"

# MCP over stdio — the SDK spawns, handshakes, converts, and closes
bun run agent-sdk --mcp docs "list the available docs"

# ...or an already-running StreamableHTTP server
bun run mcp:http-server &
bun run agent-sdk --mcp-url http://localhost:3100/mcp "list the docs"

# adaptive thinking to stderr; stdout stays answer-only
bun run agent-sdk --thinking "how many r's in strawberry?"

# effort is the SDK's depth knob (there is no --max-tokens here)
bun run agent-sdk --effort low "quick question: what is 2+2?"

# per-turn cache + cost accounting from the result's modelUsage
bun run agent-sdk --cache --tools "what time is it?"

# runaway guards (maxTurns counts conversation turns, NOT tool rounds)
bun run agent-sdk --max-turns 5 --max-budget-usd 0.50 "..."

# sessions: resume by id, continue the latest in this directory, or fork
bun run agent-sdk --continue "and what about the second one?"
bun run agent-sdk --resume <session-id> --fork "try a different approach"
bun run agent-sdk --no-persist "don't write this to ~/.claude/projects"

# also expose Claude Code's own tools (Read/Write/Edit/Bash/Glob/Grep).
# Off by default so this stays a demo of *our* tools, not a coding agent.
bun run agent-sdk --builtins --claude-code-prompt "what's in src/agent?"

# debug: our Debug frames + the SDK subprocess's stderr
bun run agent-sdk --tools --debug "..."
bun run agent-sdk --sdk-debug "..."   # also the SDK's own verbose logging

# help (includes the full "not supported here" list)
bun run agent-sdk --help
```

### In the REPL

`/model <id>` switches model mid-session, and **Ctrl+C interrupts the current
turn** rather than killing the process (on `bun run dev` it exits).

### Flags that are deliberately rejected

These are raw Messages API capabilities with no Agent SDK surface. The parser
**errors by name** rather than accepting and silently ignoring them, and points
you back at `bun run dev`:

```
--prefill  --stop  --temperature  --max-tokens  --advisor  --ptc  --runner  --stream
```

`--cache` survives here as **observability only** — breakpoint placement is the
SDK's business, but the per-turn line still reports cache reads/writes and cost.

### Two degradations worth knowing

- **MCP sampling is unavailable.** The SDK answers `roots` and elicitation but
  not `sampling/createMessage`, so `research-server.ts` always falls back to its
  raw Wikipedia extract. Run the sampling showcase on `bun run dev`.
- **`@resource` attachment becomes model-driven.** Instead of inlining the
  resource before the turn, the model decides whether to call
  `ReadMcpResourceTool`. `#prompts` has no equivalent at all.

## Build a standalone bundle

```bash
bun run build      # writes dist/index.js
bun run start "hi" # runs the bundled output
```

## Flags

These are `bun run dev` flags. The Agent SDK CLI has a different, smaller set —
see [The Agent SDK CLI](#the-agent-sdk-cli-bun-run-agent-sdk) or
`bun run agent-sdk --help`.

| Flag             | Default             | Description                                          |
|------------------|---------------------|------------------------------------------------------|
| `--model <id>`   | `claude-sonnet-4-6` | Any Anthropic model id.                              |
| `--system <txt>` | (none)              | System prompt.                                       |
| `--max-tokens N` | `1024`              | Max tokens in the response.                          |
| `--temperature N`| (model default)     | Sampling temperature, `0`–`1`.                       |
| `--once`         | off                 | Exit after the first reply (skip REPL even in TTY).  |
| `--debug`        | off                 | Log request config + response metadata to stderr.    |
| `--stream`       | off                 | Stream the response, printing tokens as they arrive. |
| `--thinking`     | off                 | Adaptive thinking (`thinking: {type:"adaptive"}`). Reasoning renders to **stderr** with a dim `[thinking]` prefix so stdout stays answer-only. Incompatible with `--prefill`; shares the `--max-tokens` cap with the answer, so raise it (a warning fires at the 1024 default). |
| `--cache`        | off                 | Top-level `cache_control: {type:"ephemeral"}` auto-caching, plus a per-turn `[cache] read=… wrote=… uncached=…` line on stderr. The minimum cacheable prefix on sonnet-4-6 is ~1024 tokens, so short prompts silently won't cache. |
| `--advisor [id]` | off / `claude-opus-4-8` | Server-side advisor tool (beta `advisor-tool-2026-03-01`): the executor consults a stronger model mid-turn. Advice renders to stderr as `[advisor] …`. Ignores `--prefill`; cannot combine with `--tools`, `--mcp`/`--mcp-url`, or `--memory`. |
| `--memory [dir]` | off / `./memories`  | Anthropic-defined memory tool (`memory_20250818`) over a local directory, so the model persists notes across turns and runs. Forces the tool-use loop on even without `--tools`. Cannot combine with `--advisor`. |
| `--prefill <txt>`| (none)              | Assistant prefill — model continues from this text.  |
| `--stop <seq>`   | (none)              | Stop sequence; repeat for multiple (max 4 per API).  |
| `--tools [names]`| off                 | Enable tool-use. Bare flag enables all built-ins; pass a comma-separated subset, e.g. `--tools calculator,get_time`. |
| `--ptc`          | off                 | Programmatic tool calling: adds the server-side `code_execution` tool and marks every `--tools` entry `allowed_callers`, so Claude scripts them in the container and only the script's output re-enters the context. Requires `--tools`; local runner only — cannot combine with `--mcp`/`--mcp-url`, `--runner sdk`, or `--advisor`. |
| `--max-iterations N` | unbounded       | Cap the tool-use loop at N assistant turns. When the cap fires, the REPL prints a warning and the model's last (unfinished) tool-call message is the final response. |
| `--runner <name>`| `local`             | Pick the tool-use loop: `local` is our hand-rolled `runAgenticTurn`; `sdk` is Anthropic's `client.beta.messages.toolRunner()` (beta API). |
| `--mcp [servers]`| off                 | Spawn MCP servers over stdio and expose their tools. Bare flag connects all registered servers (`docs`, `research`); pass a subset, e.g. `--mcp docs`. Combines with `--tools`. |
| `--mcp-url <url>`| (none)              | Connect to an already-running MCP server over StreamableHTTP (repeatable). Merges into the same session as `--mcp`. |
| `--help`         | —                   | Print usage and exit.                                |

Refusals are handled with no flag: if a turn comes back with
`stop_reason: "refusal"`, the null-guarded `stop_details` is printed to
stderr instead of an unexplained empty line.

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

## MCP (Model Context Protocol)

Two stdio servers ship with the repo — `docs` (serves the gitignored
`docs/` folder as tools + a prompt + a `docs://` resource template) and
`research` (one `research(topic)` tool that fetches Wikipedia and then uses
**MCP sampling** to ask the *client* to summarize). Neither holds an API
key; sampling is how a server reaches the model.

```bash
# standalone demo: prompts, resources, and toolRunner against the live API
bun run mcp --debug

# use MCP tools from the chat CLI (bare flag connects docs + research)
bun run dev --mcp "research the Eiffel Tower"

# in the REPL: #prompts lists MCP prompts, #<name> key=value invokes one,
# and @<resource> attaches a docs/ file to the turn
bun run dev --mcp
> #explain_topic topic="tunnel collapse" audience="engineer"
> @northvale-tunnel-collapse.md summarize this

# same docs server over StreamableHTTP instead of stdio
bun run mcp:http-server                 # [--port 3100] [--stateless] [--json-response]
bun run dev --mcp-url http://localhost:3100/mcp "list the docs"

# run either server standalone (e.g. to point inspector tooling at it)
bun run mcp:server
bun run mcp:research-server
```

`--stateless` drops session ids and with them the server→client stream, so
sampling and roots stop working and the server falls back to its hardcoded
docs dir — which is the point of the flag: it demonstrates *why*
statelessness costs you those features. See `src/mcp/CLAUDE.md`.

## RAG

`bun run rag` chunks a document, builds retrieval indices, retrieves top-k
chunks, and generates a cited answer.

```bash
# generate a synthetic handbook to play with (one API call per H1 section)
bun run rag generate-doc --out ./rag-handbook.md --sections 12

# retrieve + answer (structure chunking, hybrid retrieval, k=5 by default)
bun run rag query ./rag-handbook.md "how do we handle on-call escalation?"

# retrieval only, with the full chunk inventory and per-retriever rankings
bun run rag query ./rag-handbook.md "escalation" --no-generate --debug
```

Answers use `search_result` content blocks with `citations: {enabled: true}`,
so the citations come back **structurally** (each with `cited_text`, source,
and title) rather than being begged for in the prompt — the CLI prints them
in a `=== sources ===` section. `--no-citations` falls back to the legacy
`<chunk>` XML prompt for side-by-side comparison. Chunkers (`size`,
`structure`, `semantic`) and retrievers (`vector`, `bm25`, `hybrid`) are
selectable per query; see `src/rag/README.md`.

## Agent Skills

`bun run skills` runs an Anthropic-managed document skill inside a
server-side code-execution container and downloads whatever it produces —
the repo's only Files API consumer.

```bash
bun run skills generate --skill pptx --out ./skills-out \
  "a 3-slide deck explaining hybrid retrieval"
```

`--skill` takes `pptx`, `xlsx`, `docx`, or `pdf`. The model's narration
streams to stdout, each downloaded artifact prints as `saved <path>`, and
`--debug` emits traces to stderr. See `src/skills/CLAUDE.md`.

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
| `eval run <name> <version>`            | `--model <id>` (default `claude-sonnet-4-6`), `--batch`, `--force` | Run the prompt against the dataset; write `<version>.runs.jsonl`. Cached unless `--force`. `--batch` submits every item as one Message Batch (50% cost, async — polls until the batch ends) instead of sequential calls; rows are reassembled into dataset order by `custom_id`. |
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
│   ├── index.ts      # runCli(): args, env, MCP connections, initial turn, REPL
│   ├── args.ts       # parseArgs, printHelp
│   ├── repl.ts       # runRepl(), sendTurn() — the conversation loop
│   ├── hooks.ts      # agentic hooks: tool traces, y/N approval, [thinking] rendering
│   ├── mcp-turn.ts   # #prompt invocation and @resource mentions
│   └── stdin.ts      # readStdin() for piped input
├── core/             # Anthropic client + message orchestration
│   ├── index.ts      # public barrel
│   ├── client.ts     # AnthropicClient singleton (init/get/reset)
│   ├── messages.ts   # addUserMessage, addAssistantMessage, streamAssistantMessage, parseAssistantMessage
│   ├── advisor.ts    # streamAdvisorMessage — server-side advisor tool
│   ├── batches.ts    # runMessageBatch — Message Batches API
│   ├── constants.ts  # DEFAULT_MODEL, DEFAULT_MAX_TOKENS, SAMPLING_MODEL, ADVISOR_MODEL
│   ├── debug.ts      # Debug singleton (dbg.log/section/block/json)
│   ├── cli.ts        # makeCli/runMain helpers shared by the sub-CLIs
│   ├── util.ts       # errMsg helper
│   └── tools/            # tool-use: Tool union, per-tool files, runAgenticTurn loop
│       ├── types.ts      # Tool = CustomTool | AnthropicDefinedTool
│       ├── define.ts     # defineTool() — betaZodTool wrapper, sets strict: true
│       ├── memory.ts     # memory_20250818 over a local dir
│       ├── echo.ts / get_time.ts / calculator.ts / get_weather.ts
│       ├── builtins.ts   # BUILTIN_TOOLS registry + selectTools() + MUTATING_TOOLS
│       ├── agentic.ts    # runAgenticTurn (local loop; PTC container + pause_turn)
│       └── agentic_sdk.ts # runAgenticTurnSdk (client.beta.messages.toolRunner)
├── agent/            # the same chat CLI on the Claude Agent SDK (`bun run agent-sdk`)
│   ├── main.ts       # thin entry → runAgentCli()
│   ├── cli.ts        # runAgentCli(): args, session, initial turn, REPL
│   ├── args.ts       # AgentArgs, parseAgentArgs, printAgentHelp + rejected-flag table
│   ├── session.ts    # buildOptions() + startAgentSession() — the one query() call
│   ├── inbox.ts      # push-style AsyncGenerator<SDKUserMessage> (streaming input)
│   ├── render.ts     # SDKMessage → terminal; replaces the whole AgenticHooks surface
│   ├── approve.ts    # canUseTool y/N gate + the serializing mutex
│   ├── hooks.ts      # PreToolUse: force-ask mutating tools, block .env reads
│   ├── mcp.ts        # MCP_SERVERS registry → Options.mcpServers
│   ├── repl.ts       # readline loop, /model, Ctrl+C interrupts the turn
│   └── tools/        # builtins.ts (in-process MCP server) + memory.ts
├── mcp/              # Model Context Protocol (`bun run mcp`)
│   ├── servers/      # docs-server, http-docs-server, research-server + registry
│   ├── client/       # connection (stdio + StreamableHTTP), sampling, roots, tools/prompts/resources
│   └── cli.ts        # standalone demo of the SDK's MCP helpers
├── rag/              # chunking + retrieval + cited answers (`bun run rag`)
│   ├── chunkers/     # size, structure, semantic
│   ├── bm25.ts / vector-store.ts / hybrid.ts / embedder.ts
│   ├── generate-answer.ts  # search_result blocks + structural citations
│   └── cli.ts
├── skills/           # Agent Skills + Files API (`bun run skills`)
│   ├── generate.ts   # container.skills + code execution + artifact download
│   └── cli.ts
└── eval/             # prompt evaluation module (`bun run eval`)
    ├── index.ts      # public barrel — helper kit + types
    ├── cli.ts        # subcommand dispatcher
    ├── types.ts      # Zod schemas + inferred TS types
    └── …             # paths, jsonl, scaffold, dataset, runner, graders, checks
```

Each module carries its own doc: `src/cli/CLAUDE.md`, `src/core/CLAUDE.md`,
`src/core/tools/CLAUDE.md`, `src/agent/CLAUDE.md`, `src/mcp/CLAUDE.md`,
`src/eval/CLAUDE.md`, `src/skills/CLAUDE.md`, and `src/rag/README.md`.

`cli/` is everything specific to being a terminal program. `core/` is the
LLM-facing piece — singleton client, message primitives, the tool-use loop
in `core/tools/`, and the advisor/batches surfaces — reusable by non-CLI
callers. `mcp/`, `rag/`, `skills/`, and `eval/` are sub-CLIs built on top of
`core/`, each with its own `bun run` entry point.

`agent/` is the one module that does **not** sit on `core/`'s client: it talks
to the Claude Agent SDK, which spawns the bundled Claude Code binary and owns
the loop. It still reuses `core/`'s tool registry, memory backend, `Debug`
singleton, and the `mcp/servers/` registry — so the two CLIs share their tools
and servers while differing entirely in how a turn is executed. Note that
`core/`'s "the `messages` array is the source of truth" invariant does not hold
there: the transcript lives in the SDK's subprocess and on disk.

## Notes

- Requires Bun >= 1.1. Install on macOS with `brew install oven-sh/bun/bun`.
- TS strict mode is on; run `bun run typecheck` to verify types without emitting.
