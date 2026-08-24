# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install            # install deps
bun run dev [prompt]   # run from source (TTY → REPL, piped stdin → single-shot)
bun run typecheck      # tsc --noEmit, strict mode
bun run build          # bundle to dist/index.js (target: bun, minified)
bun run start [prompt] # run the bundled output
bun run mcp --debug    # MCP demo: spawns the stdio server, exercises tools/prompts/resources
                       # (--debug recommended: section headers are Debug traces on stderr)
bun run mcp:server     # run the docs MCP server standalone (for inspector tooling)
bun run mcp:http-server      # same docs server over StreamableHTTP (Bun.serve, /mcp)
                             # [--port 3100] [--stateless] [--json-response];
                             # connect with: bun run dev --mcp-url http://localhost:3100/mcp
bun run mcp:research-server  # run the research MCP server standalone (Wikipedia + sampling)
bun run skills generate --skill pptx --out ./skills-out "<prompt>"
                       # Agent Skills demo: runs an Anthropic-managed document skill in a
                       # server-side code-execution container, downloads the generated
                       # files (see src/skills/CLAUDE.md)
bun run check          # Biome: format-verify + lint + import-sort (no writes)
bun run check:write    # Biome: apply formatting, safe lint fixes, import-sort
bun run format         # Biome: format src/**/*.ts in place
bun run lint           # Biome: lint only
```

There is no test suite. `bun run check` (Biome) and `bun run typecheck` are the
two correctness gates — run both after any edit; CI runs them on push/PR. A
`PostToolUse` hook (`.claude/settings.json` → `.claude/hooks/biome-format.sh`)
also auto-formats each file Claude writes or edits. Formatting/linting is
configured in `biome.json` (2-space, double-quote, 80-col — Prettier-matched;
scoped to `src/**/*.ts`; `noAssignInExpressions` disabled for the idiomatic
`while ((m = re.exec(…)))` pattern).

`ANTHROPIC_API_KEY` must be set; Bun auto-loads `.env` so a local `.env` works.

## Architecture

The two core modules under `src/` (the others — `mcp/`, `eval/`, `rag/`,
`skills/` — have their own docs: `src/mcp/CLAUDE.md`,
`src/eval/CLAUDE.md`, `src/rag/README.md`, `src/skills/CLAUDE.md`;
`cli/` and `core/` do too: `src/cli/CLAUDE.md`, `src/core/CLAUDE.md`):

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
unconditionally via `dbg.log` / `dbg.section` / `dbg.block` /
`dbg.json` — the enabled
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

### Request-shaping flags (`--thinking`, `--cache`)

Both are bare flags parsed in `cli/args.ts` and folded into the single
`requestOpts` object `sendTurn` builds, so they ride the existing
`Partial<Omit<…>>` option types down every path (single-shot, `--stream`,
and both agentic runners) with **no new `core/` surface**:

- **`--thinking`** sends `thinking: {type:"adaptive"}` (GA on
  claude-sonnet-4-6; the deprecated `budget_tokens` form is not used).
  Rendering is `cli/hooks.ts`: `attachThinkingListener(stream)` wires the
  SDK's `"thinking"` stream event to **stderr** with a dim `[thinking]`
  prefix (stdout stays answer-only, so pipes are unaffected), and
  `writeThinking()` renders a complete `thinking` block on the
  non-streaming path. `signature_delta` never reaches the `"thinking"`
  event, so it's ignored for display by construction. Gotchas the parser
  encodes: `--thinking` + `--prefill` is a parse-time error (prefill is
  rejected when thinking is on), and thinking shares the `max_tokens`
  budget with the answer — at the 1024 `DEFAULT_MAX_TOKENS` the answer can
  be squeezed out, so a stderr warning fires telling you to raise
  `--max-tokens`.
- **`--cache`** sends top-level `cache_control: {type:"ephemeral"}` —
  auto-caching, where the API places the breakpoint on the last cacheable
  block (a deliberate simplification over manual 4-breakpoint management).
  Verification is a per-turn stderr line
  `[cache] read=… wrote=… uncached=…` from the response `usage`. The
  minimum cacheable prefix on claude-sonnet-4-6 is ~1024 tokens, so short
  prompts silently don't cache and show `read=0 wrote=0` — a long
  `--system`, a multi-turn REPL history, or `--mcp` plus an `@resource`
  mention are the reliable ways to see a hit.

Refusals are handled **always-on, no flag**: `reportTurnOutcome()` in
`repl.ts` runs after both the tools and single-shot branches, and a
`stop_reason === "refusal"` turn (any Claude 4+ model can return one)
prints the null-guarded `stop_details.category` / `.explanation` to
stderr instead of an unexplained empty line. The same function prints the
`--cache` usage line.

### Tools (`src/core/tools/`)

Anthropic tool-use lives in `core/tools/` as a self-contained module:
`types.ts` defines `Tool` as a **union of two flavors** —
`CustomTool` (`BetaTool & { run, parse? }`, where `BetaTool` comes from
`@anthropic-ai/sdk/resources/beta` — the variant `betaZodTool`
produces) and `AnthropicDefinedTool` (`{ type, name } & { run, parse? }`,
no `input_schema`, because the model owns the schema). The
`isAnthropicDefinedTool` predicate narrows on the *absence* of
`input_schema`, so any future server-shaped tool passes through
unchanged.
`define.ts` exports `defineTool`, a thin wrapper around the SDK's
`betaZodTool` (from `@anthropic-ai/sdk/helpers/beta/zod`) that derives
JSON `input_schema` from a Zod schema and returns both `run` and a
`parse` function the executor uses to validate the model's input. It
also sets **`strict: true`** (no beta header — the API then guarantees
`tool_use.input` matches the schema exactly) and normalizes the schema
to carry `additionalProperties: false`, which strict requires.
`strict` has to be set on the returned object because `betaZodTool`'s
options type has no such field while the `BetaTool` shape does — one
cast, same pattern as before. **MCP-sourced tools stay non-strict**
(third-party schemas may not satisfy strict's constraints; a 400 there
would kill the turn).
`memory.ts` builds the Anthropic-defined **memory tool**
(`memory_20250818`) over a local directory via the SDK's
`betaMemoryTool(handlers)`: a filesystem backend implementing
view/create/str_replace/insert/delete/rename with canonical-path
containment checks. It is *not* in `MUTATING_TOOLS` — that set gates by
name, and gating "memory" would prompt on `view` and break the piped
path; sandboxed writes under the gitignored `memories/` dir are treated
as non-mutating (documented in `tools/CLAUDE.md`).
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
`--tools name1,name2` (subset), and `--memory [dir]` (bare =
`./memories`) appends the memory tool. Either one takes the tools
branch, which always streams (no `--stream` flag needed) and ignores
`--prefill`; `--memory` is parse-time exclusive with `--advisor` for the
same reason `--tools` is. When both are unset and no MCP tools are
loaded, `sendTurn` calls the existing single-shot primitives unchanged.

With `--debug`, the agentic loop emits framed `[debug] agentic round`,
`[debug] tool call`, and `[debug] tool result` payloads to stderr in
addition to the existing `stream event` frames (which include
`input_json_delta` for tool inputs as they're built up).

### MCP (`src/mcp/`)

MCP landed as a top-level module (sibling of `cli/`/`core/`, superseding
the earlier "sibling module in core/" note; see `src/mcp/CLAUDE.md` for
the module doc):

The module is two symmetric folders — **`servers/`** (key-free stdio
server entries + a registry) and **`client/`** (connection, sampling,
SDK conversion helpers) — plus the `cli.ts` demo and the `index.ts`
barrel. The split mirrors the protocol's two sides; the load-bearing rule
is that **servers hold no API key** and reach the model only via sampling.

- **`servers/docs-server.ts`** exports `buildDocsServer()` (every tool /
  prompt / resource registration) and is also the standalone **stdio** entry
  built with `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`,
  hooked up behind an `import.meta.main` guard so importing the factory never
  attaches a transport), grounded in the repo's gitignored `docs/` folder
  (populated by the rag walkthrough; missing/empty is handled gracefully).
  It exposes two
  non-mutating tools (`list_docs`, `read_doc` — `read_doc` refuses paths
  that escape `docs/`), an XML-tagged `explain_topic` prompt, and a
  `docs://{+path}` resource template. The docs base dir is discovered from a
  client-advertised `file://` root via the MCP `roots` capability (resolved
  lazily + cached by `resolveDocsDir()`), with a hardcoded fallback for the
  standalone/inspector path that advertises no roots. Never writes to stdout
  (that's the JSON-RPC stream); does not import `@/core`.
- **`servers/research-server.ts`** is a second stdio server. Its one tool,
  `research(topic)`, fetches the full Wikipedia extract and then **uses MCP
  sampling** to ask the *client* to summarize it
  (`server.server.createMessage`), falling back to the raw extract if
  sampling is unavailable. Also key-free — sampling is how it does model
  work.
- **`servers/http-docs-server.ts`** serves `buildDocsServer()` over
  **StreamableHTTP** (`bun run mcp:http-server`): `Bun.serve` routes
  POST/GET/DELETE at `/mcp` into the MCP SDK's
  `WebStandardStreamableHTTPServerTransport`. Stateful by default
  (`sessionIdGenerator: () => crypto.randomUUID()`, a `sessionId → transport`
  map, `initialize` opens a session); `--stateless` passes
  `sessionIdGenerator: undefined` and builds a throwaway server+transport per
  request; `--json-response` sets `enableJsonResponse`. Stateless removes the
  server→client stream, so sampling and `roots/list` are unavailable and the
  servers' existing fallbacks kick in — that degradation is the point of the
  flag. Key-free and `@/core`-free like the stdio entries.
- **`servers/index.ts`** is the registry: `MCP_SERVERS` and
  `selectServers("all" | names)` (mirrors `selectTools`); the single
  source of truth for which **stdio** servers `--mcp` spawns (`--mcp-url`
  needs no registry — the URL is the address).
- **`client/connection.ts`** — `connectMcpServer(spec)` spawns one server
  over `StdioClientTransport` (10s handshake timeout) and
  `connectMcpServerHttp(name, url)` connects to a running one over
  `StreamableHTTPClientTransport`; both advertise
  `capabilities: { sampling: {}, roots: { listChanged: false } }`, install the
  sampling and roots handlers before connecting, and return the same
  `{ name, client, alive, close }` (shared `createMcpClient` / `handshake` /
  `trackConnection` internals, so the transports can't drift).
  `connectMcpServers(specs)` connects several stdio servers (loud-fail: close
  opened, rethrow). Startup failure throws `McpConnectError` (CLI prints +
  exits 1); mid-session death flips `McpConnection.alive` and warns once.
- **`client/sampling.ts`** answers `sampling/createMessage`: convert the
  request's messages, run a one-shot via `addAssistantMessage` on
  `SAMPLING_MODEL` (Haiku — defined in `core/constants.ts`), return the
  summary. **The only MCP file that touches the Anthropic client** (the
  client owns the key).
- **`client/roots.ts`** answers `roots/list`: returns the repo's `docs/`
  dir (resolved from `process.cwd()`, `pathToFileURL`-encoded) as a single
  `file://` root named `"docs"`, so the docs server discovers where to serve
  from instead of hardcoding it. Imports `@/core` only for `Debug`, not the
  Anthropic client.
- **Conversion to Claude types is the Anthropic SDK's job** — the
  `@anthropic-ai/sdk/helpers/beta/mcp` helpers, not hand-rolled mapping:
  `mcpTools` (adapted to the local `Tool` shape in `client/tools.ts`),
  `mcpMessages` (`client/prompts.ts`), and `mcpResourceToContent`
  (`client/resources.ts`; `text/*` resources become *document* blocks —
  use `resourceBlockText` to extract). The MCP SDK `Client` doesn't
  structurally satisfy `MCPClientLike`; the guard-then-convert step lives
  in one util, `mcpRunnableTools()` (narrows via `isMcpClientLike()`, then
  calls `mcpTools()`), shared by `loadMcpTools` and `cli.ts` — never a cast.
- **CLI**: `--mcp` connects all registered servers at startup (or a subset:
  `--mcp docs,research`) and `--mcp-url <url>` (repeatable, http(s) validated
  at parse time) adds already-running StreamableHTTP servers to the same
  connection list; every server's tools merge into the agentic loop (both
  `--runner` values; combines with `--tools`; duplicate names throw — note
  `--mcp docs` plus a `--mcp-url` pointed at `mcp:http-server` is the same
  server twice). In `sendTurn`, a leading `#` invokes an MCP prompt (`#prompts`
  lists them across servers, `#explain_topic topic="…" audience="…"`
  appends the prompt's messages), and `@<resource>` mentions (bare
  `@northvale-tunnel-collapse.md` or full `docs://…` URI) are resolved
  against each server (first hit wins) and attached as XML-tagged
  (`<resource uri="…">`) blocks ahead of the user text. All connections
  close in a `finally` in `runCli`.
  `bun run dev --mcp "research the Eiffel Tower"` is the end-to-end
  sampling showcase.
- **`cli.ts`** (`bun run mcp`) showcases the helpers natively against
  the live API: prompt → `mcpMessages` → `beta.messages.create`,
  resource → `mcpResourceToContent` → an XML-tagged turn, and
  `mcpTools` → `beta.messages.toolRunner`.

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
