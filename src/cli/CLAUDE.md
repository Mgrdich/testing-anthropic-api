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
  `runRepl()` (the readline `> ` loop). The agentic hook wiring and the
  MCP prompt/`@`-mention handling are extracted into `hooks.ts` and
  `mcp-turn.ts` (below); `sendTurn` imports from both.
- `hooks.ts` — `buildAgenticHooks()`, the one `AgenticHooks` factory for
  both runners (stdout text deltas, stderr `[tool]` traces, `y/N`
  approval), plus `attachThinkingListener()` / `writeThinking()` (the
  `--thinking` renderers, shared with `repl.ts`) and the private
  `truncate`/`compactJson` formatters.
- `mcp-turn.ts` — MCP turn construction: `handleMcpPrompt()` (the
  `#`-prefixed prompt path) and `buildMentionContent()` (the
  `@resource` → XML-tagged content path). Both take the array of
  connected servers and multiplex across them (prompts labelled by
  server; mentions resolved first-hit-wins), and are no-ops without
  `--mcp`. The two sigils are exported constants `PROMPT_PREFIX` (`#`)
  and `MENTION_PREFIX` (`@`) — the single source of truth for the
  dispatch, the regex, every user-facing string, and the `--help`
  text. `/` is intentionally left free for future REPL commands.
- `stdin.ts` — `readStdin()`: `""` on a TTY; otherwise reads all of
  stdin and trims.

## Control flow (`runCli`)

1. `parseArgs` — throws on bad flags; caught, printed as
   `error: …` + usage, exit 2.
2. `--debug` flips the process-global `Debug` singleton once; nothing
   else threads debug state.
3. `--mcp`: `connectMcpServers(selectServers(args.mcp))` +
   `loadMcpTools()` per connection (merged) **before any turn**. Bare
   `--mcp` connects all registered servers; `--mcp docs,research` a
   subset. Failure is loud (`error: failed to start MCP server: …`,
   exit 1) — never a silent fallback to a tool-less session. Every
   connection is closed in a `finally` that covers all REPL exit paths
   (empty line, `exit`/`quit`, Ctrl+C/D). Known quirk: the
   `--once`-without-prompt path calls `process.exit(2)` inside the
   `try`, which skips the `finally`; harmless, because the children's
   stdin closes when the parent dies.
4. Initial prompt = positional `args.prompt ?? readStdin()`. If
   present, one `sendTurn` runs before the TTY check.
5. Non-TTY stdin or `--once` → return (single-shot). Otherwise
   `runRepl` with the same `messages` array, so history spans the
   initial turn and all REPL turns.

## `sendTurn` pipeline (`repl.ts`)

Per turn, in order:

1. **User-turn construction.** With `--mcp`: a leading `#`
   (`PROMPT_PREFIX`) routes to `handleMcpPrompt` (`#prompts` lists to
   stderr and sends nothing; `#<name> key=value key="multi word"`
   fetches the prompt via `getPromptMessages` and appends its
   messages); otherwise `buildMentionContent` resolves `@<name>`/`@<uri>`
   mentions (`MENTION_PREFIX`) via
   `readResourceBlock`, attaching each as an XML-tagged
   (`<resource uri="…">`) text block ahead of the user text
   (non-text resources pass through as blocks; failed lookups warn and
   stay literal). Without `--mcp`, plain `addUserMessage`.
2. **`requestOpts` construction.** One object (model, max-tokens,
   system, temperature, stop sequences, plus `thinking` / `cache_control`
   from `--thinking` / `--cache`) built once and handed to *every*
   branch below, so a new request field never needs per-branch wiring.
   See "Request-shaping flags" below.
3. **Tools branch** — taken when `--tools` is set, MCP tools are
   loaded, *or* `--memory` is set. Merges `selectTools(args.tools)` +
   `mcpTools` (the latter already flattened across all connected
   servers) + `createMemoryTool(args.memory)`, throws on duplicate
   names (the API 400s), builds hooks, and picks the runner:
   `--runner sdk` → `runAgenticTurnSdk`, else `runAgenticTurn`. Always
   streams; ignores `--prefill`. With `--ptc` it also passes the PTC
   options (below). A returned `stop_reason` of `"tool_use"` or
   `"pause_turn"` means a cap fired — warn on stderr, naming
   `--max-iterations` when it was set and the runner's always-on
   consecutive-`pause_turn` ceiling otherwise (see
   `src/core/tools/CLAUDE.md`).
4. **Advisor branch** — taken when `--advisor` is set (parse-time
   exclusive with `--tools`/`--mcp`/`--memory`, so it never competes
   with the tools branch). Calls `streamAdvisorMessage` with
   `{ ...requestOpts, advisor_model: args.advisor }`; always streams
   (text deltas to stdout, `attachThinkingListener` for `--thinking`)
   and ignores `--prefill` by returning before the prefill print. After
   the stream, each `advisor_tool_result` block in the final content is
   rendered to stderr by `renderAdvisorResult` — see "Advisor" below.
5. **Single-shot branch** — `streamAssistantMessage` (with `--stream`)
   or `addAssistantMessage`; `--prefill` is printed first and merged
   into history by core. `thinking` blocks are handled (streamed by
   `attachThinkingListener`, or rendered by `writeThinking` on the
   non-streaming path) and so stay out of the "not rendered" tally;
   remaining non-text blocks are counted and warned on stderr.
6. **`reportTurnOutcome(response, args)`** — the shared post-turn
   diagnostics, called at the end of *every* branch. Prints the
   always-on refusal line and, with `--cache`, the usage line (below).
   It takes `Anthropic.Message | BetaMessage` because `--runner sdk`
   and `--advisor` return the beta shape; the fields it reads (`stop_reason`,
   `stop_details`, `usage`) are identical across the two.

## Request-shaping flags (`--thinking`, `--cache`)

Both are bare flags. Neither adds any `core/` surface: they are spread
into `sendTurn`'s `requestOpts` and flow through the existing
`Partial<Omit<…>>` option types to the single-shot primitives *and* both
agentic runners.

### `--thinking`

Sends `thinking: { type: "adaptive", display: "summarized" }` (GA on
claude-sonnet-4-6; the `budget_tokens` form is deprecated there and unused
here). **`display` is explicit on purpose:** it defaults to `"summarized"`
on sonnet-4-6 but to `"omitted"` on 4.7-and-later models, where the
thinking blocks still arrive with *empty text* — so under `--model
claude-opus-5` the renderer would print a `[thinking]` prefix and nothing
after it, looking like a broken flag. Rendering
lives in `hooks.ts` and is shared by both stream-listener sites — the
single-shot `--stream` path in `repl.ts` and `buildAgenticHooks`'
`onStream` — so thinking looks the same everywhere:

- `attachThinkingListener(stream)` wires the SDK's `"thinking"` event to
  stderr behind a dim `[thinking]` prefix, closing the styling on
  `content_block_stop` so each thinking block gets its own prefixed
  line. The `"thinking"` event only carries `thinking_delta`, so
  `signature_delta` is excluded from display by construction — don't
  add a `streamEvent` branch for it.
- `writeThinking(text)` renders a whole `thinking` block on the
  non-streaming path.
- ANSI dim/reset are empty strings unless `process.stderr.isTTY`, so
  redirected diagnostics carry no escape codes.

Gotchas, enforced in `parseArgs`: `--thinking` with `--prefill` is a
parse-time error (prefill is rejected when thinking is enabled), and
thinking shares the `--max-tokens` budget with the answer — at the 1024
default the answer can be squeezed out entirely, so a stderr warning
fires (a warning, not an error: short thinking runs are legitimate).

### `--cache`

Sends top-level `cache_control: { type: "ephemeral" }` — auto-caching,
where the API places the breakpoint on the last cacheable block. This is
a deliberate divergence from manual 4-breakpoint management: simpler, and
adequate for this CLI. Verification is a per-turn stderr line from
`reportTurnOutcome`:

```
[cache] read=<cache_read_input_tokens> wrote=<cache_creation_input_tokens> uncached=<input_tokens>
```

The minimum cacheable prefix on claude-sonnet-4-6 is ~1024 tokens, so a
short prompt **silently doesn't cache** — you'll see `read=0 wrote=0` and
nothing is wrong. To actually see a hit, give it a large enough prefix: a
long `--system`, several REPL turns of history, or `--mcp` plus an
`@resource` mention. Works under both `--runner` values.

### Refusals (always on, no flag)

Any Claude 4+ model can return `stop_reason === "refusal"`, which
otherwise prints as a silent empty line. `reportTurnOutcome` always
checks for it and writes the null-guarded
`refusal: model declined to answer (category: …) — <explanation>` to
stderr. The server-side `fallbacks` parameter is deliberately *not*
implemented (deferred — it only fires for models this repo doesn't
default to).

## Programmatic tool calling (`--ptc`)

Bare flag. Adds the server-side code-execution tool to the request and
marks every client-side tool `allowed_callers:
["code_execution_20260120"]`, so Claude writes a script in the container
that calls our tools as functions — intermediate results never enter the
model's context, only the script's final output does. All of the wiring
lives in `runAgenticTurn` (container-id threading, `pause_turn` resume,
the projection); `sendTurn` only assembles the three options
(`server_tools: [PTC_CODE_EXECUTION_TOOL]`, `allowed_callers:
[PTC_TOOL_TYPE]`, `omit_strict: true`) and spreads them next to
`max_iterations`. The mechanics and their rationale are documented once,
in `src/core/tools/CLAUDE.md` → "Programmatic tool calling".

`--ptc` is the **first non-composing flag pair set** in this CLI. Four
parse-time rules, checked in `parseArgs` *before* the advisor rule so the
PTC-specific message wins:

| Combination        | Why it's rejected                                    |
| ------------------ | ---------------------------------------------------- |
| `--ptc --mcp`      | The API rejects MCP tools alongside code execution   |
| `--ptc --runner sdk` | `toolRunner` can't auto-resume `pause_turn`        |
| `--ptc --advisor`  | The advisor turn runs outside the agentic loop        |
| `--ptc` without `--tools` | Nothing for the container to script            |

`--thinking` / `--cache` compose fine (same `requestOpts`). `--memory`
composes too, but note that `allowed_callers` is stamped on *every*
client-side tool, so the memory tool becomes container-only as well.
Under `--debug` (or plain stderr), a tool call issued from the container
is annotated `[tool] name(input) via code_execution_20260120` — the
`caller` argument `buildAgenticHooks` now receives from `onToolCall`;
`"direct"` stays unannotated.

## Advisor (`--advisor [model]`)

`--advisor` enables the server-side advisor tool for the session: the
executor model (`--model`, default claude-sonnet-4-6) can consult a
stronger advisor model mid-turn and the API runs that sub-inference
itself. Bare flag = `ADVISOR_MODEL` (claude-opus-4-8); an optional value
overrides it, validated loosely (any model-id-shaped token is accepted —
an unknown id is the API's 400 to explain), using the same
"consume-the-next-arg-only-if-it-looks-like-a-value" heuristic as
`--tools`/`--mcp`.

Rendering lives in `renderAdvisorResult` (`repl.ts`), which **switches on
the `advisor_tool_result` block's `content` union** — only one member has
`.text`, so never read it unconditionally:

| content type                | output                                    |
| --------------------------- | ----------------------------------------- |
| `advisor_result`            | `[advisor] <text>` on stderr              |
| `advisor_redacted_result`   | `[advisor] redacted` (opaque blob)        |
| `advisor_tool_result_error` | `warning: advisor tool error (<code>)`    |

Constraints, all deliberate for v1:

- Parse-time error when combined with `--tools` or `--mcp` — the advisor
  runs server-side, outside the agentic loop.
- Always streams (`--stream` is redundant) and ignores `--prefill`, like
  the tools branch.
- `--thinking` / `--cache` work: they are part of the same `requestOpts`.
- The flag is per-session by design: once an `advisor_tool_result` block
  is in history the tool must stay declared on every later request, and
  the full block (redacted blob included) must be echoed back verbatim —
  `streamAdvisorMessage` pushes the whole content array for that reason.

## Output discipline

- **stdout** carries model output (text deltas / final text) and the
  REPL banner/prompt. Nothing else.
- **stderr** carries everything diagnostic: `[tool] name(input)` /
  `  → result` traces (truncated to 200 chars unless `--debug`),
  `[thinking] …` deltas, `[advisor] …` advice,
  `[cache] read=… wrote=… uncached=…`,
  `refusal: …`, `[mcp] attached resource …`, warnings, errors, and all
  `Debug` frames. This keeps piped usage (`… | bun run dev`) clean —
  and is why `--thinking` renders to stderr rather than stdout.

## Hooks (`buildAgenticHooks`)

One factory wires `AgenticHooks` for both runners: `onStream` prints
text deltas (plus `attachThinkingListener` for `--thinking`, and
`streamEvent` frames under `--debug`), `onToolCall` /
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
  flags. Four flags are *heuristic* instead — `--tools`, `--mcp`,
  `--advisor`, `--memory` all take an optional value and consume the
  next arg only if it looks like one (a name list, a model id, a path),
  so `--tools "hello world"` / `--memory "what do you remember?"` treat
  the string as the prompt. `--memory`'s test is path-shaped: a leading
  `.`/`/`/`~` or an embedded `/`. (`--ptc` is a plain bare flag.)
- New flags touch three places: the `Args` type, the `switch` case,
  and `printHelp()`.
- Cross-flag validation (incompatible pairs, budget warnings) goes in
  the block after the `for` loop in `parseArgs`, not in the `switch` —
  flag order must not change the outcome. `--thinking` vs `--prefill`
  (throw), `--ptc` vs `--mcp`/`--runner sdk`/`--advisor`/missing
  `--tools` (throw), `--advisor` vs `--tools`/`--mcp`/`--memory`
  (throw), and the `--thinking` max-tokens warning are the examples.
  Within that block, order *does* decide which message a caller sees for
  an overlapping pair — the `--ptc` checks run first for that reason.
- Anything printed once per turn regardless of branch belongs in
  `reportTurnOutcome`, not duplicated in the tools and single-shot
  paths.
