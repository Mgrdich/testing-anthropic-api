# `src/cli/`

The main `testing-anthropic` CLI: terminal concerns only. Entry is
`runCli()` (called by the 3-line `src/index.ts`), exposed as
`bun run dev` / `bun run start`. Everything reusable by non-terminal
callers — message primitives, the agentic loops, MCP fetching/conversion
— lives in `src/core/` and `src/mcp/`; this module parses argv, reads
stdin, drives readline, and prints.

## Layout

- `args.ts` — the `Args` type, `parseArgs(argv)`, and `printHelp()`.
  A hand-rolled, strongly-typed parser tailored to this CLI's flag set
  (the "subcommand + flag bag" sub-CLIs use `@/core/cli.ts` instead —
  do not merge the two).
- `index.ts` — `runCli(argv)`: parse → `--help` → `--debug` enable →
  MCP connect (when `--mcp`) → initial turn → REPL or exit.
- `repl.ts` — `sendTurn()` (one conversational turn end-to-end) and
  `runRepl()` (the readline `> ` loop), plus the agentic hook wiring
  and the MCP slash-command/@-mention handling.
- `stdin.ts` — `readStdin()`: `""` on a TTY; otherwise reads all of
  stdin and trims.

## Control flow (`runCli`)

1. `parseArgs` — throws on bad flags; caught, printed as
   `error: …` + usage, exit 2.
2. `--debug` flips the process-global `Debug` singleton once; nothing
   else threads debug state.
3. `--mcp`: `connectLocalMcp()` + `loadMcpTools()` **before any turn**.
   Failure is loud (`error: failed to start MCP server: …`, exit 1) —
   never a silent fallback to a tool-less session. The connection is
   closed in a `finally` that covers every REPL exit path (empty line,
   `exit`/`quit`, Ctrl+C/D). Known quirk: the
   `--once`-without-prompt path calls `process.exit(2)` inside the
   `try`, which skips the `finally`; harmless, because the child's
   stdin closes when the parent dies.
4. Initial prompt = positional `args.prompt ?? readStdin()`. If
   present, one `sendTurn` runs before the TTY check.
5. Non-TTY stdin or `--once` → return (single-shot). Otherwise
   `runRepl` with the same `messages` array, so history spans the
   initial turn and all REPL turns.

## `sendTurn` pipeline (`repl.ts`)

Per turn, in order:

1. **User-turn construction.** With `--mcp`: a leading `/` routes to
   `handleMcpSlash` (`/prompts` lists to stderr and sends nothing;
   `/<name> key=value key="multi word"` fetches the prompt via
   `getPromptMessages` and appends its messages); otherwise
   `buildMentionContent` resolves `@<name>`/`@<uri>` mentions via
   `readResourceBlock`, attaching each as an XML-tagged
   (`<resource uri="…">`) text block ahead of the user text
   (non-text resources pass through as blocks; failed lookups warn and
   stay literal). Without `--mcp`, plain `addUserMessage`.
2. **Tools branch** — taken when `--tools` is set *or* MCP tools are
   loaded. Merges `selectTools(args.tools)` + `mcpTools`, throws on
   duplicate names (the API 400s), builds hooks, and picks the runner:
   `--runner sdk` → `runAgenticTurnSdk`, else `runAgenticTurn`. Always
   streams; ignores `--prefill`. A `stop_reason === "tool_use"` result
   means the `--max-iterations` cap fired — warn on stderr.
3. **Single-shot branch** — `streamAssistantMessage` (with `--stream`)
   or `addAssistantMessage`; `--prefill` is printed first and merged
   into history by core. Non-text response blocks aren't rendered —
   counted and warned on stderr.

## Output discipline

- **stdout** carries model output (text deltas / final text) and the
  REPL banner/prompt. Nothing else.
- **stderr** carries everything diagnostic: `[tool] name(input)` /
  `  → result` traces (truncated to 200 chars unless `--debug`),
  `[mcp] attached resource …`, warnings, errors, and all `Debug`
  frames. This keeps piped usage (`… | bun run dev`) clean.

## Hooks (`buildAgenticHooks`)

One factory wires `AgenticHooks` for both runners: `onStream` prints
text deltas (and `streamEvent` frames under `--debug`), `onToolCall` /
`onToolResult` print the stderr traces, `isMutating` checks
`MUTATING_TOOLS`, and `approveMutating` prompts `y/N` through the
REPL's readline interface — the one-shot/piped path has no `rl` and
throws instead, by design. Approval prompts are serialized by the local
runner; see `src/core/tools/CLAUDE.md` for the divergence in the SDK
runner.

## Conventions

- The `messages: MessageParam[]` array created in `runCli` is the
  conversation's single source of truth; `cli/` passes it down and
  never clones it. Anything that needs cross-turn state belongs in
  `core/` (or `mcp/`), not here.
- `parseArgs` uses the `argv[++i]` + `if (!v) throw` pattern to
  satisfy `noUncheckedIndexedAccess` — keep it for new value-taking
  flags. `--tools` is the one heuristic flag: it consumes the next arg
  only if it looks like a tool list, so `--tools "hello world"` treats
  the string as the prompt.
- New flags touch three places: the `Args` type, the `switch` case,
  and `printHelp()`.
