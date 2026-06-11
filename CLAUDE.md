# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install            # install deps
bun run dev [prompt]   # run from source (TTY → REPL, piped stdin → single-shot)
bun run typecheck      # tsc --noEmit, strict mode
bun run build          # bundle to dist/index.js (target: bun, minified)
bun run start [prompt] # run the bundled output
```

There is no test suite. `bun run typecheck` is the only correctness gate — run it
after any edit.

`ANTHROPIC_API_KEY` must be set; Bun auto-loads `.env` so a local `.env` works.

## Architecture

Two modules under `src/`:

- **`cli/`** owns terminal concerns: arg parsing (`args.ts`), the readline
  conversation loop (`repl.ts`), piped stdin reading (`stdin.ts`), and the
  `runCli()` orchestrator (`index.ts`).
- **`core/`** owns the Anthropic client surface: `addUserMessage`,
  `addAssistantMessage`, and `streamAssistantMessage` (`messages.ts`), plus
  default model / max-tokens (`constants.ts`). Re-exported from
  `core/index.ts`. `streamAssistantMessage` uses the SDK's
  `client.messages.stream()` helper and hands the raw `MessageStream` to an
  optional `onStream(stream)` callback so the caller can wire `.on("text",
  …)`, `.on("streamEvent", …)`, etc.; it appends the final assembled message
  to the `messages` array, so history behaves identically to the
  non-streaming path. Both `addAssistantMessage` and `streamAssistantMessage`
  take an optional `prefill?: string` argument: when set, they send the
  request with a trailing `{role:"assistant",content:prefill}` and merge the
  prefill into the first text block of the response before pushing to
  history, so the saved assistant turn matches what was printed. Stop
  sequences need no new surface — they flow through `opts.stop_sequences`
  via the existing `Partial<Omit<…>>` option types. Note: Claude Sonnet 4.6
  currently rejects assistant prefill with a 400; use a prefill-capable
  model (e.g., `claude-haiku-4-5-20251001`) when exercising that path.

Debug tracing is a process-global singleton, `Debug.get()` in
`core/debug.ts` (same lazy-singleton shape as `Embedder.get()`). Each CLI
calls `.enable()` once when it parses `--debug`; call sites then trace
unconditionally via `dbg.log` / `dbg.block` / `dbg.json` — the enabled
check lives inside the methods, so no `if (debug)` guards at call sites.
Pass expensive trace bodies as thunks (only evaluated when enabled), and
read `dbg.enabled` only where debug changes behavior rather than emitting
a trace (e.g. full vs. truncated tool results in `repl.ts`). Do not thread
`debug` booleans through function signatures or option types.

`src/index.ts` is a 3-line entry that calls `runCli()`.

Dual execution mode lives in `cli/index.ts`:

1. Resolve the initial prompt from `args.prompt ?? readStdin()` and, if
   present, send one turn.
2. If `process.stdin.isTTY`, hand off to `runRepl()` — readline `> ` prompt
   that appends each line to the same `messages: MessageParam[]` array so
   history is preserved across turns. Exits on empty line, `exit`/`quit`, or
   Ctrl+C/D.
3. If stdin is piped (non-TTY), return after the single turn.

The `messages` array is the conversation's source of truth — both
`addUserMessage` and `addAssistantMessage` mutate it. Anything that needs
context across turns (future tool-use loops, etc.) should plug in via this
array inside `core/`, not in `cli/`.

### Tools (`src/core/tools/`)

Anthropic tool-use lives in `core/tools/` as a self-contained module:
`types.ts` defines `Tool` as `BetaTool & { run, parse? }` (where
`BetaTool` comes from `@anthropic-ai/sdk/resources/beta` — the variant
`betaZodTool` produces);
`define.ts` exports `defineTool`, a thin wrapper around the SDK's
`betaZodTool` (from `@anthropic-ai/sdk/helpers/beta/zod`) that derives
JSON `input_schema` from a Zod schema and returns both `run` and a
`parse` function the executor uses to validate the model's input.
Each shipped tool lives in its own file (`echo.ts`, `get_time.ts`,
`calculator.ts`, `get_weather.ts` — all non-mutating, demo-only) and
is built with `defineTool`. `builtins.ts` imports them and exposes the
`BUILTIN_TOOLS` registry, `selectTools(filter)`, and the
`MUTATING_TOOLS` name set (a sidecar that flags side-effecting tools
since `betaZodTool`'s return type doesn't carry a `mutating` flag).
`agentic.ts` exports `runAgenticTurn`, which wraps
`streamAssistantMessage` in a `stop_reason === "tool_use"` loop and
runs each call as `parse → run → catch` (matching the SDK's own
`runRunnableTool`). Within a round, tool dispatch happens in two
phases: serial `approveMutating` prompts (y/N can't interleave) then
parallel `Promise.all` execution. The loop accepts a
`max_iterations` cap (matching the SDK's `toolRunner` semantics); when
hit, it returns the last assistant message with
`stop_reason === "tool_use"` so callers can detect the cap fired. A
second runner, `runAgenticTurnSdk` in `agentic_sdk.ts`, is the
SDK-backed alternative (calls `client.beta.messages.toolRunner()`);
the REPL picks between them via `--runner local|sdk` (default
`local`).
Tools listed in `MUTATING_TOOLS` are gated through
`hooks.approveMutating` (y/N prompt in the REPL); the one-shot/piped
path throws because no TTY is available.

The CLI opts in via `--tools` (bare = all built-ins) or
`--tools name1,name2` (subset). The tools path always streams (no
`--stream` flag needed) and ignores `--prefill`. When `--tools` is
unset, `sendTurn` calls the existing single-shot primitives unchanged.

With `--debug`, the agentic loop emits framed `[debug] agentic round`,
`[debug] tool call`, and `[debug] tool result` payloads to stderr in
addition to the existing `stream event` frames (which include
`input_json_delta` for tool inputs as they're built up).

MCP integration is still planned but not yet scaffolded — same shape:
belongs in `core/` (likely a sibling `mcp/` module) so it can be reused
by non-CLI callers.

## TypeScript conventions enforced by `tsconfig.json`

- **Absolute imports only** via the `@/*` → `./src/*` path alias. Do not
  introduce `./` or `../` imports. Example: `import { runCli } from "@/cli/index.ts";`.
- **Include the `.ts` extension** in import specifiers
  (`allowImportingTsExtensions: true`).
- **`verbatimModuleSyntax: true`** — type-only imports/exports must be
  marked: `import type { Foo }` or `import { type Foo }`, and
  `export type { Foo }` in barrels.
- **`noUncheckedIndexedAccess: true`** — array / record index access is
  `T | undefined`; narrow before use (see the `argv[++i]` guards in
  `cli/args.ts`).
- Strict mode is on; no implicit `any`, no implicit overrides.

When adding a new module, give it an `index.ts` barrel and have callers
import from `@/<module>/index.ts` (not deep paths) unless a leaf import is
necessary.
