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
  `client.messages.stream()` helper and exposes an optional
  `onTextDelta(delta)` callback; it appends the final assembled message to
  the `messages` array, so history behaves identically to the non-streaming
  path.

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

Tools and MCP integration are planned but not yet scaffolded — they belong
in `core/` (or sibling `tools/` / `mcp/` modules consumed by `core/`) so
they can be reused by non-CLI callers.

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
