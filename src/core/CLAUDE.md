# `src/core/`

The reusable, terminal-free Anthropic client surface. Consumed by
`src/cli/` (the main CLI), `src/eval/`, `src/rag/`, and `src/mcp/` —
nothing in here may touch readline, prompt the user, or assume a TTY.
The only stderr writer is the `Debug` singleton (silent unless a CLI
enables it). Public API is re-exported from `src/core/index.ts`;
import from the barrel, not deep paths.

## Layout

- `messages.ts` — the conversation primitives (see below).
- `client.ts` — `AnthropicClient`, the lazy SDK-client singleton.
- `constants.ts` — `DEFAULT_MODEL` (`claude-sonnet-4-6`) and
  `DEFAULT_MAX_TOKENS` (1024). The single place model defaults live.
- `debug.ts` — `Debug`, the process-global trace provider.
- `util.ts` — `errMsg(e)`: `Error.message` or `String(e)`. Use it in
  every `catch` that formats an error for output.
- `cli.ts` — argv helpers for **subcommand-style sub-CLIs** (eval,
  rag): `runMain`, `makeCli(usage)`, `parseArgs` (flag bag),
  `getString`/`getBoolFlag`, `writeUsageError`. The main CLI in
  `src/cli/` deliberately does *not* use this — it has its own typed
  parser. New `bun run <module> <subcommand>` CLIs should use this.
- `tools/` — the tool-use loops and built-in tool registry. Has its
  own doc: `src/core/tools/CLAUDE.md`.
- `index.ts` — the barrel; re-exports everything above including the
  tools surface.

## Conversation primitives (`messages.ts`)

The `messages: MessageParam[]` array is the conversation's source of
truth, and these functions **mutate it**:

```ts
addUserMessage(messages, text)                       // push user turn
addAssistantMessage(messages, opts?, prefill?)       // create() + push
streamAssistantMessage(messages, opts?, onStream?, prefill?)
                                                     // stream() + push
extractText(content)                                 // join text blocks
```

- Both assistant primitives apply `DEFAULT_MODEL` / `DEFAULT_MAX_TOKENS`
  and spread caller `opts` over them. Option types
  (`AddAssistantOptions`, `StreamAssistantOptions`) are
  `Partial<Omit<…, "messages">>` of the SDK request types, so new
  request fields (e.g. `stop_sequences`) flow through without new
  surface.
- `streamAssistantMessage` hands the raw `MessageStream` to the
  optional `onStream(stream)` callback (callers wire `.on("text", …)`
  etc.), then awaits `finalMessage()` and pushes it — history is
  identical to the non-streaming path.
- **Prefill contract:** when `prefill` is set, the request gets a
  trailing `{role:"assistant", content:prefill}` and the response's
  first text block is re-merged with the prefill before pushing, so
  saved history matches what was printed. Note Claude Sonnet 4.6 (the
  default model) rejects assistant prefill with a 400 — exercise that
  path with a prefill-capable model (e.g.
  `claude-haiku-4-5-20251001`).

## Client singleton (`client.ts`)

`AnthropicClient.get()` lazily constructs one SDK client from
`ANTHROPIC_API_KEY` (Bun auto-loads `.env`) and throws with a setup
hint when the key is missing. `init({apiKey})` overrides explicitly;
`reset()` clears (tests). Never `new Anthropic()` elsewhere — go
through the singleton so key handling stays in one place.

## Debug (`debug.ts`)

Process-global lazy singleton, same shape as `AnthropicClient`. CLIs
call `Debug.get().enable()` once when parsing `--debug`; call sites
trace unconditionally via `dbg.log` / `dbg.section` / `dbg.block` /
`dbg.json` — the
enabled check lives inside the methods, so no `if (debug)` guards.
Pass expensive payloads as thunks (evaluated only when enabled). Read
`dbg.enabled` only where debug changes *behavior* rather than emitting
a trace. Never thread `debug` booleans through signatures or option
types.

## Sub-CLI helpers (`cli.ts`)

For the `bun run <module> <subcommand> [--flag value]` pattern.
`parseArgs` returns `{positional, flags}` where a flag is `true`
(bare) or the following string. `makeCli(USAGE)` returns typed getters
(`getInt`/`getFloat`/`getBool`/`getEnum`) that `die` with the usage
block on invalid values, and `runMain(main)` is the shared
top-level catch (exit 1 with `error: <msg>`). Gotcha preserved in the
`DieFn` type: destructuring `cli.die` loses TS's `never`-return
narrowing — anchor it with `const die: DieFn = cli.die`.

## Invariants

- **No terminal I/O.** No readline, no prompts, no `process.stdout`
  writes from library code (the eval/rag sub-CLI *entry files* may
  print; this module's library code may not). Interactive decisions are
  injected by callers — e.g. the REPL passes `approveMutating` into the
  agentic hooks rather than core asking anything itself.
- **History mutation is the contract.** Anything that needs context
  across turns plugs in via the `messages` array (the tool loops in
  `tools/` follow it too); don't introduce parallel state.
- **Defaults live in `constants.ts`** and are applied inside the
  primitives — callers omit `model`/`max_tokens` unless overriding.
- When adding a module-level export, add it to `index.ts` (types via
  `export type`, per `verbatimModuleSyntax`).
