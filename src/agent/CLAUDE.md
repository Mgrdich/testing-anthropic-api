# `src/agent/`

The conversational CLI, rebuilt on the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) instead of the raw Anthropic SDK. Entry is
`runAgentCli()` (`bun run agent-sdk`); `src/cli/` (`bun run dev`) is untouched and
remains the home for every raw-Messages-API feature.

This module exists to answer one question: **how much of this app's hand-rolled
agent machinery does Anthropic's own harness replace?** The answer is "the
entire loop, and most of the MCP plumbing — but none of the request-shaping
knobs." Both halves of that are documented below; the second half is why this
is an *additional* CLI rather than a replacement.

> **The Agent SDK is Claude Code packaged as a library, not a Messages API
> wrapper.** `query()` spawns the bundled Claude Code binary as a subprocess
> and speaks its control protocol over stdio. Every option is closer to a CLI
> flag than to a request field, and the binary — not this code — resolves auth,
> tools, permissions, settings, and history.

## Layout

- `main.ts` — 4-line entry: `runMain(runAgentCli)`.
- `cli.ts` — `runAgentCli(argv)`: parse → `--help` → `--debug` → start session
  → initial turn → REPL or return → `finally session.close()`.
- `args.ts` — `AgentArgs`, `parseAgentArgs`, `printAgentHelp`. Hand-rolled in
  the same style as `cli/args.ts`, including the "consume the next arg only if
  it looks like a value" heuristic for `--tools` / `--mcp` / `--memory`. Also
  holds `UNSUPPORTED`, the table of `bun run dev` flags that are **rejected by
  name** here (see "What does not port").
- `session.ts` — **the load-bearing file.** `buildOptions()` assembles the one
  `Options` object; `startAgentSession()` calls `query()` once and runs the
  message pump.
- `inbox.ts` — `createInbox()`: a push-style `AsyncGenerator<SDKUserMessage>`,
  the prompt side of a streaming-input query.
- `render.ts` — `createRenderer(args)`: `SDKMessage` → terminal. Replaces the
  entire `AgenticHooks` surface plus `reportTurnOutcome`.
- `approve.ts` — the y/N gate: `buildCanUseTool(rlRef)` plus the serializing
  mutex that keeps two prompts from interleaving.
- `hooks.ts` — `buildAgentHooks()`: a `PreToolUse` hook that forces `"ask"` for
  mutating tools and blocks `.env` reads.
- `mcp.ts` — `buildMcpServerConfigs(args)`: the existing `MCP_SERVERS` registry
  → `Options.mcpServers`.
- `repl.ts` — `runAgentRepl()`: readline over `inbox.push`, plus `/model` and
  Ctrl+C-interrupts-the-turn.
- `tools/builtins.ts` — the four demo tools as one in-process MCP server.
- `tools/memory.ts` — the memory tool over the *existing* `createMemoryHandlers`.
- `index.ts` — barrel.

## Control flow, versus `runCli`

`runCli` (`src/cli/`) keeps a `messages: MessageParam[]` array as the source of
truth, connects MCP itself, and branches three ways per turn (tools / advisor /
single-shot), re-sending the whole conversation each time.

`runAgentCli` does none of that. One `query()` spans the whole session:

1. `createInbox()` produces the `AsyncGenerator<SDKUserMessage>` that feeds it.
2. `query({ prompt: inbox.stream(), options })` is called **once** and returns
   synchronously.
3. A detached `pump()` runs `for await (const message of q)` for the life of
   the session, handing each message to the renderer and resolving the
   front-most turn deferred when a `type: "result"` arrives.
4. `send(text)` pushes onto the inbox and awaits its deferred. That is the
   entire per-turn API.
5. `close()` closes the inbox, closes the query, and awaits the pump.

**Streaming input is used for every mode, including `--once` and piped stdin**,
rather than the simpler string-prompt form of `query()`. Two reasons: every
`Query` control method (`interrupt`, `setModel`, `setPermissionMode`) is
streaming-input-only, and a string-prompt query *throws* after yielding an
error result. One shape everywhere removes a class of divergence.

**Turn completion is a FIFO deferred queue**, not a pair of nullable callbacks
— messages can be pushed faster than the agent processes them, and
`waiters.shift()` narrows cleanly under `noUncheckedIndexedAccess`. If the
stream ends with turns still pending they are rejected rather than left hanging.

## Options assembly — the four settings that matter

Everything else in `buildOptions` is a direct flag mapping. These four are
load-bearing and would be wrong if defaulted:

| Setting | Why it is set this way |
|---|---|
| `settingSources: []` | **In 0.3.251 omitting this loads user + project + local settings.** The agent would silently inherit `~/.claude/settings.json`, this repo's `.claude/settings.json` hooks, and this repo's `CLAUDE.md` — making demo behavior depend on the developer's machine. `--inherit-settings` opts back in. |
| `tools: []` | `tools` gates *availability* of Claude Code's own built-ins (`allowedTools` only gates permission). Left unset, Bash/Write/Edit/Read are all live and this stops being a demo of *our* tools. `--builtins` opts in; with MCP configured we widen to the two MCP-resource tools. |
| `env` **never set** | Unlike the Python SDK, `Options.env` **replaces** rather than merges. Setting it at all drops `PATH`, `HOME`, and the `ANTHROPIC_API_KEY` that Bun's `.env` autoload provides. Leaving it unset is what makes auth work. |
| `allowedTools` **never set** | See "The approval gate" below — a bare name there auto-approves *before* `canUseTool` runs. |

`systemPrompt` is only set when `--system` is given; omitting it yields the
SDK's **minimal tool-calling prompt**, not Claude Code's, which is what matches
`bun run dev`'s default of no system prompt. `--claude-code-prompt` opts into
the real preset (and then `--system` becomes its `append`).

## The approval gate

`MUTATING_TOOLS` still drives it, but the mechanism is two-sided, and the
first side is a trap:

- **A tool named in `allowedTools` never reaches `canUseTool`.** The SDK warns
  about this at startup (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). We therefore do
  not set `allowedTools` at all: `canUseTool` allows non-mutating tools
  silently and prompts y/N for mutating ones, so there is exactly one decision
  point. The `PreToolUse` hook additionally forces `permissionDecision: "ask"`
  for mutating tools, so a settings rule cannot shadow the gate either.
- **The SDK dispatches tools in parallel and may call `canUseTool`
  concurrently.** `runAgenticTurn` had a dedicated serial approval phase for
  exactly this reason; `approve.ts` rebuilds it as a promise-chain mutex. This
  is the one piece of the hand-rolled loop that does *not* simply disappear.

Where `bun run dev` throws on the no-TTY path, this returns
`{ behavior: "deny", message: … }` — the model gets a reason instead of the
turn dying, and the "mutating tools need a TTY" contract is preserved.

## Output discipline

Unchanged in spirit, but it must be re-established deliberately: the
`SDKMessage` union has ~38 variants and it is easy to leak a diagnostic.

- **stdout** — model text only, written from exactly one place: the
  `stream_event` → `text_delta` branch. Plus the REPL banner and prompt.
- **stderr** — `[thinking]`, `[tool]` / `→` traces, `[cache]`, refusal and
  warning lines, and all `Debug` frames.

**Do not also print text blocks from `type: "assistant"` messages.** With
`includePartialMessages` on they already went out as deltas, and the CLI emits
one assistant message *per completed content block* — printing both double-
prints every token. The `default` branch of the renderer counts unhandled
message types under `--debug` rather than dropping them silently, since the
union grows between SDK versions.

## What does not port

Each of these is a raw Messages API capability with **no Agent SDK surface**
(verified against the shipped `sdk.d.ts`). `parseAgentArgs` rejects the flag by
name with a pointer rather than accepting and ignoring it.

| Flag / feature | Why | Still works on |
|---|---|---|
| `--prefill` | No way to seed a trailing assistant turn; `query()` drives a CLI turn loop, not `messages.create`. | `bun run dev` |
| `--stop` | `stop_sequences` is not exposed. | `bun run dev` |
| `--temperature` | No sampling parameters at all. | `bun run dev` |
| `--max-tokens` | No per-request output cap. Use `--max-turns` / `--max-budget-usd`. | `bun run dev` |
| `--advisor` | The `advisor_20260301` server tool is not configurable. (`Settings.advisorModel` exists as a *name in a type*; building on it would be guessing.) | `bun run dev` |
| `--ptc` | No `allowed_callers`, no `code_execution`, no container threading. | `bun run dev` |
| `--runner` | There is exactly one loop — that is the point. | — |
| `--stream` | Streaming is always on (`includePartialMessages`). | — |
| Explicit `cache_control` | Breakpoint placement is the CLI's. **`--cache` survives as observability only**, printing `cacheReadInputTokens` / `cacheCreationInputTokens` / `costUSD` from `result.modelUsage` (which is *cumulative* across turns). | `bun run dev` for placement |
| Message Batches | Not exposed; this is why `eval run --batch` cannot follow. | `bun run eval` |
| Strict tool use | No per-tool wire definition to set `strict` on. Partly compensated: the in-process MCP server Zod-validates every call *before* the handler, so malformed input is still rejected — one round later, client-side. | `bun run dev` |
| `stop_details` on refusals | `stop_reason` survives as a plain string; `category` / `explanation` do not. The refusal line is correspondingly less informative. | `bun run dev` |
| **MCP sampling** (we answer `sampling/createMessage`) | The SDK answers `roots` and elicitation but **not** sampling — there is no handler to register. `research-server.ts` therefore *always* takes its raw-extract fallback here. `bun run dev --mcp "research the Eiffel Tower"` has no port. | `bun run dev` |
| `#prompts` / `#<name>` | MCP prompts are not reachable through the SDK's turn API. | `bun run dev` |
| `@resource` mentions | Replaced by model-driven `ListMcpResourcesTool` / `ReadMcpResourceTool` (included in `tools` when MCP is configured). Attachment becomes a decision the model makes rather than a deterministic pre-turn inline, and the `<resource uri="…">` wrapper is gone. | `bun run dev` for exact fidelity |
| The `messages: MessageParam[]` contract | **`src/core/`'s "the messages array is the source of truth" invariant does not hold in this module.** The transcript lives in the subprocess and on disk. | — |

The last row is the deepest change, and it buys something the array never had:
`--resume`, `--continue`, `--fork`, and `--no-persist`, backed by the SDK's
session store.

### `roots/list`: a correction worth knowing

Grepping the SDK's option surface suggests roots is unsupported. **It is not** —
the bundled Claude Code binary answers `roots/list` itself, with the
**workspace root (cwd)**. That broke `docs-server` the first time this CLI
spawned it: the server's contract is "root === the docs dir itself", so it
happily walked the whole repo, `.git` and `node_modules` included, and returned
a 555k-character listing.

The fix is in `src/mcp/servers/docs-server.ts`: match the root by **name**
(`"docs"`, which `client/roots.ts` sets) rather than trusting the first
`file://` root, and fall back to `FALLBACK_DOCS_DIR` otherwise. `bun run dev`
is unaffected; the agent CLI now correctly serves `docs/`.

## Conventions

- Flags map to `Options` fields in `buildOptions` and nowhere else. Cross-flag
  validation goes in the block after the `for` loop in `parseAgentArgs`, so
  argv order cannot change the outcome — same rule as `cli/args.ts`.
- Tool names reach the model as `mcp__{serverKey}__{tool}`. `qualified()` /
  `unqualify()` in `tools/builtins.ts` are the only places that know the
  prefix; traces and the mutating check both strip it. Because of this
  namespacing, the duplicate-tool-name guard from `bun run dev` is unnecessary
  here — collisions are structurally impossible.
- The Zod shapes in `src/core/tools/*.ts` are exported as raw shapes
  (`echoShape`, `calculatorShape`, …) and consumed both by `defineTool`
  (`z.object(shape)`) and by the SDK's `tool()` (which wants the raw shape).
  One declaration, two surfaces — do not let them drift.
- New tool → add it to `BUILTIN_TOOLS` and export its shape; `createBuiltinsServer`
  picks it up from `selectTools` automatically.
