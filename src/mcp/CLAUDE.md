# `src/mcp/`

MCP (Model Context Protocol) servers + client. The servers are stand-ins for
external MCP servers; the client side converts their tools, prompts, and
resources for Claude using the **Anthropic SDK's MCP helpers**
(`@anthropic-ai/sdk/helpers/beta/mcp`) — conversion is never hand-rolled
here.

The module is split into two symmetric folders that mirror the protocol's two
sides: **`servers/`** holds the standalone, key-free stdio server entries plus
the registry of which servers exist; **`client/`** holds everything that runs
on the client side — connecting, answering sampling requests, and the SDK
conversion helpers. This boundary is load-bearing: a server holds **no API
key** and never calls the model directly; when it needs model work it asks the
client via **sampling** (see below).

CLI entries: `bun run mcp` (the demo, `cli.ts`), `bun run mcp:server`
(docs server standalone), and `bun run mcp:research-server` (research server
standalone). The module also plugs into the main `bun run dev` CLI via the
`--mcp` flag — see the CLI section below. Public API is re-exported from
`src/mcp/index.ts`.

## Layout

```
src/mcp/
├── servers/   stdio server entries + registry
├── client/    connection, sampling, SDK conversion helpers
├── cli.ts     bun run mcp demo (entry, not exported)
└── index.ts   module barrel (re-exports client/ + servers/)
```

### `servers/`

- `docs-server.ts` — standalone stdio server (`bun run mcp:server`), built
  with `@modelcontextprotocol/sdk` and grounded in the repo's gitignored
  `docs/` folder (populated by the rag walkthrough; missing/empty docs/
  degrades gracefully). Registers `list_docs` and `read_doc` tools (the
  latter path-traversal-guarded to `docs/`), the XML-tagged `explain_topic`
  prompt, and a `docs://{+path}` resource template — its `list` callback
  enumerates every file in `docs/`; reading resolves one item.
- `research-server.ts` — standalone stdio server (`bun run mcp:research-server`).
  One tool, `research(topic)`: fetches the full plain-text Wikipedia extract
  (action API, capped at 10k chars) and then **uses MCP sampling** to ask the
  *client* to summarize it (`server.server.createMessage(...)`). Falls back to
  the raw extract if sampling is unavailable or returns nothing. Like
  `docs-server.ts`, it imports no `@/core` and holds no API key — the sampling
  round-trip is exactly how it does model work anyway.
- `index.ts` — the **registry**: `MCP_SERVERS` (name → `{ name, scriptPath }`,
  via `satisfies` so the keys stay literal), the derived `McpServerName`
  union, `isMcpServerName` (the parser validates `--mcp` names with it), and
  `selectServers("all" | McpServerName[])`. Single source of truth for which
  servers `--mcp` can spawn (mirrors `BUILTIN_TOOLS`/`selectTools`).

### `client/`

- `connection.ts` — `connectMcpServer(spec)` spawns one server over
  `StdioClientTransport` and returns `{ name, client, alive, close }`; it
  advertises `capabilities: { sampling: {} }` and installs the sampling
  handler before connecting. `connectMcpServers(specs)` connects several
  (loud-fail: close the opened ones and rethrow if any fails).
  `connectDocsServer()` is the docs-only shorthand the demo uses.
- `sampling.ts` — `installSamplingHandler(client)` registers a handler for
  `sampling/createMessage`: it converts the request's messages to
  `MessageParam[]`, runs a one-shot via `addAssistantMessage` on
  `SAMPLING_MODEL` (Haiku), and returns the summary. **This is the only MCP
  file that imports `@/core`** — the client owns the key.
- `tools.ts` — `mcpRunnableTools()` (the shared guard-then-convert step:
  `isMcpClientLike` narrow → SDK `mcpTools()`; also used by `cli.ts`) and
  `loadMcpTools()`: `listTools()` → `mcpRunnableTools()` → adapt each
  `BetaRunnableTool` to the local `Tool` shape from `core/tools`.
- `prompts.ts` — `listMcpPrompts()` / `getPromptMessages()` (SDK
  `mcpMessages()`), backing the REPL's `#` prompt commands.
- `resources.ts` — `listMcpResources()` / `readResourceBlock()` (SDK
  `mcpResourceToContent()`) / `resourceBlockText()`, backing the REPL's
  `@` mentions.
- `index.ts` — client barrel.

## CLI

### `bun run mcp` (demo, `cli.ts`)

Self-contained showcase of the Anthropic SDK helpers, run against the
live API (needs `ANTHROPIC_API_KEY`). Spawns the server, then walks four
sections in order: server info → inventory (`listTools` / `listPrompts` /
`listResources`) → prompt via `mcpMessages` → resource via
`mcpResourceToContent` (sent as an XML-tagged turn) → agentic turn via
`mcpTools` + `beta.messages.toolRunner`. Tool calls echo to stderr as
`[model-facing] [tool] name(input)` / `  → result`. Exits 1 with
`error: failed to start MCP server: …` if the spawn/handshake fails.

For learning purposes every output line is tagged by who consumes the
content (legend printed at startup): `[app-facing]` for MCP JSON-RPC
between the demo process and the spawned server (handshake, inventory,
resource reads), `[model-facing]` for content that enters or comes back
from Claude's context (prompt messages, the XML-tagged resource turn,
tool schemas, tool calls/results), and `[user-facing]` for narration
and Claude's final answers.

Run it as `bun run mcp --debug`: the section headers are
`[debug] section: …` Debug traces on stderr, so without the flag the
demo output runs together with no separators.

| Flag      | Effect                                                                              |
|-----------|-------------------------------------------------------------------------------------|
| `--debug` | Enables `Debug` frames (`section: …` headers, `mcp connect`, `mcp server info`, …) |

### `bun run mcp:server` / `bun run mcp:research-server` (servers standalone)

Each starts one stdio server and idles waiting for a JSON-RPC client;
Ctrl+C to exit. Mainly useful with inspector tooling, e.g.
`bunx @modelcontextprotocol/inspector bun run src/mcp/servers/research-server.ts`.
Not needed for `bun run mcp` / `--mcp` — those spawn their own children.
(The research tool only summarizes when driven by a sampling-capable
client; the inspector lists it but won't perform the sampling round-trip.)

### `--mcp` on the main CLI (`bun run dev --mcp`)

Connects **all registered servers** at startup; `--mcp docs,research`
selects a named subset (same heuristic as `--tools`). Failure to start any
server is a loud exit 1 (no silent degradation); every connection is closed
in `runCli`'s `finally`. Tools from all servers are loaded and merged into
one set. Three affordances, all implemented in `cli/mcp-turn.ts` on top of
this module's exports, and all **multiplexed across servers**:

- **Tools** — every server's tools merge into the agentic loop. Works
  alone (`--mcp` = MCP tools only) or combined with `--tools`
  (duplicate names across built-ins *and* servers throw), under both
  `--runner local` and `--runner sdk`.
- **`#` prompt commands → prompts** — `#prompts` (or `#help`) lists every
  live server's prompts to stderr, each labelled `[server]`; `#<name>
  key=value key="multi word"` finds the first live server exposing that
  prompt, fetches it via `getPromptMessages`, and appends its messages to
  history before the normal send. Unknown prompt / no live server →
  stderr error, no API call. (`/` is reserved for future REPL commands;
  the sigil is the `PROMPT_PREFIX` constant in `cli/mcp-turn.ts`.)
- **`@` mentions → resources** — `@<name>` (e.g.
  `@northvale-tunnel-collapse.md`) or `@<uri>` (e.g.
  `@docs://northvale-tunnel-collapse.md`) is resolved against each live
  server in turn (first hit wins) via `readResourceBlock` and attached as
  an XML-tagged (`<resource uri="…">…</resource>`) content block ahead of
  the user text. Unresolvable mentions warn and stay literal.

`bun run dev --mcp "research the Eiffel Tower"` is the end-to-end sampling
showcase: Claude calls the `research` tool, which fetches Wikipedia and
asks *this* client to summarize via sampling (Haiku), then answers from the
returned summary.

Piped stdin exercises the same paths single-shot
(`echo '#prompts' | bun run dev --mcp`). With `--debug`, the module adds
`mcp connect` / `mcp server info` / `mcp tools` / `mcp prompt` /
`mcp resource` / `mcp sampling` frames to the existing agentic traces.

## Invariants

- **stdout purity (servers)**: each server's stdout *is* the JSON-RPC
  stream. Any `console.log` corrupts it — diagnostics go to stderr only.
  Servers also must not import `@/core` (no API key, faithful "external
  server" stand-in). The corollary: a server that needs the model uses
  **sampling** instead of calling it directly.
- **Sampling lives client-side, and only there imports `@/core`.**
  `client/sampling.ts` is the one MCP file that touches the Anthropic
  client: it answers `sampling/createMessage` with a `SAMPLING_MODEL`
  (Haiku) one-shot. The connection must advertise
  `capabilities: { sampling: {} }` *and* `installSamplingHandler` before
  `client.connect`, or servers' `createMessage` calls error. Keep model
  defaults (incl. `SAMPLING_MODEL`) in `core/constants.ts`.
- **The `Tool` adapter flattens to text.** `loadMcpTools` wraps each
  runnable tool's `run` to return a string (local `Tool` contract): text
  blocks pass verbatim, any other block type degrades to a `[type]`
  placeholder. The bundled tools are text-only; if a future MCP tool
  returns images/documents, the REPL path loses that fidelity (the
  `cli.ts` / `toolRunner` path keeps it).
- **`text/*` resources convert to *document* blocks.** The SDK's
  `mcpResourceToContent` maps text resources to
  `{type:"document", source:{type:"text", …}}`, not a text block. Use
  `resourceBlockText()` to extract text; don't match on
  `block.type === "text"` alone.
- **One guard point for the MCP SDK.** The MCP `Client` doesn't
  structurally satisfy the helpers' `MCPClientLike` (its `callTool`
  return union includes a legacy `{toolResult}` shape selected by a
  compatibility result-schema argument the helpers never pass) — the
  narrow lives in `mcpRunnableTools()` in `tools.ts` (the
  `isMcpClientLike()` type guard checks `callTool` exists at runtime,
  then hands off to the SDK's `mcpTools()`); both `loadMcpTools` and
  `cli.ts` go through it instead of casting. `tools.ts` also
  guards each converted tool with `isCustomRunnableTool` and the
  wrapper input with `isRecord`, so the module has no `as` casts.
- **Tool names must not collide — across built-ins *and* every server.**
  The REPL merges `--tools` and all `--mcp` servers' tool sets into one
  list and throws on duplicate names (the API 400s otherwise). Pick
  distinct names when adding server tools (`research`, `list_docs`, … are
  taken).
- **Failure surface**: startup problems throw `McpConnectError`
  (`connectMcpServers` closes any already-opened connections and rethrows;
  the CLI prints + exits non-zero); mid-session server death flips that
  one `McpConnection.alive` (checked by the prompt/mention paths, which
  skip dead servers) and warns once on stderr. Tool calls against a dead
  server surface as normal tool errors through the agentic loop's
  parse → run → catch.

## Adding a server

Add a `servers/<name>-server.ts` entry (an `McpServer` over
`StdioServerTransport`, stderr-only diagnostics, **no `@/core`**), then
register it in `servers/index.ts` (`MCP_SERVERS`). Add a
`mcp:<name>-server` script in `package.json` for inspector use. Nothing
else changes: `--mcp` picks it up via the registry, and its
tools/prompts/resources are discovered via `list*()` at connect time. If
it needs the model, request **sampling** (`server.server.createMessage`) —
the client answers it.

## Adding a capability to a server

Register it in the server file (`registerTool` / `registerPrompt` /
`registerResource`, zod schemas, `.describe()` on every field). Tools
should return `{ content: [{ type: "text", text }] }`. Nothing on the
client side needs changing.

The docs-backed capabilities share two helpers in `docs-server.ts`:
`listDocFiles()` (recursive `docs/` listing; `[]` when the folder is
missing) and `docPath()` (rejects paths that resolve outside `docs/`).
New file-serving capabilities should go through them rather than calling
`readFile` with model-supplied paths directly.
