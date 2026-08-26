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
(docs server standalone over stdio), `bun run mcp:http-server` (the same docs
server over StreamableHTTP), and `bun run mcp:research-server` (research server
standalone). The module also plugs into the main `bun run dev` CLI via the
`--mcp` (stdio) and `--mcp-url` (HTTP) flags — see the CLI section below.
Public API is re-exported from `src/mcp/index.ts`.

## Layout

```
src/mcp/
├── servers/   server entries (stdio + HTTP) + the stdio registry
├── client/    connection, sampling, SDK conversion helpers
├── cli.ts     bun run mcp demo (entry, not exported)
└── index.ts   module barrel (re-exports client/ + servers/)
```

## Transports

Both transports carry the same protocol and the same capabilities; what
differs is who owns the server process and whether there's a durable session.

| | stdio (`--mcp`) | StreamableHTTP (`--mcp-url`) |
|---|---|---|
| Process | we spawn it (`bun run <script>`) | already running, ours or not |
| Registry | `servers/index.ts` (`MCP_SERVERS`) | none — the URL *is* the address |
| Session | the child process's lifetime | server-minted `mcp-session-id`, or none (`--stateless`) |
| Server→client | always (sampling, roots) | stateful only |
| stdout | **is** the JSON-RPC stream | free (JSON-RPC rides HTTP bodies/SSE) |

The client side is identical for both: same `Client`, same advertised
`sampling` + `roots` capabilities, same `McpConnection` shape — so tools,
`#` prompts and `@` mentions never learn which transport they're on.

**Stateful vs stateless is the interesting knob.** A stateful HTTP session
mints a session id at `initialize`, the client echoes it in the
`mcp-session-id` header, and the GET SSE stream carries **server→client**
requests. `sessionIdGenerator: undefined` (`--stateless`) removes the session
— and with it that channel, so `sampling/createMessage` and `roots/list` can't
be issued at all. Nothing errors: the servers' existing graceful fallbacks
take over (the docs server serves `FALLBACK_DOCS_DIR` instead of the
client-advertised root; a sampling server like `research-server.ts` would
return its raw extract). That degradation *is* the demo — statelessness is
what costs you server→client features, not any change to the server's code.

### `servers/`

- `docs-server.ts` — `buildDocsServer()` (the exported factory holding every
  registration) plus the **stdio** entry (`bun run mcp:server`), built with
  `@modelcontextprotocol/sdk` and grounded in the repo's gitignored
  `docs/` folder (populated by the rag walkthrough; missing/empty docs/
  degrades gracefully). The stdio hookup at the tail is guarded by
  `import.meta.main`, so `http-docs-server.ts` can import the factory without
  a transport attaching itself to that process's stdio. Each factory call
  returns an independent server with its **own** docs-dir cache (roots are a
  per-client answer; the HTTP server builds one per session). The docs base
  dir is discovered from a
  client-advertised `file://` root via `roots/list`, resolved lazily and
  cached by `resolveDocsDir()` (memoizes the promise so concurrent first
  callers share one round-trip), falling back to a hardcoded `import.meta.url`
  path when no roots-capable client is present (the standalone/inspector
  case). `docPath()` is therefore `async`. Registers `list_docs` and
  `read_doc` tools (the latter path-traversal-guarded to the resolved dir),
  the XML-tagged `explain_topic` prompt, and a `docs://{+path}` resource
  template — its `list` callback enumerates every file; reading resolves one
  item.
- `http-docs-server.ts` — the docs server over **StreamableHTTP**
  (`bun run mcp:http-server`). `Bun.serve` routes POST / GET / DELETE at
  `/mcp` into the MCP SDK's `WebStandardStreamableHTTPServerTransport` (fetch
  `Request` in, `Response` out — no Node adapter). Flags: `--port` (default
  3100), `--stateless`, `--json-response` (`enableJsonResponse: true` — one
  JSON body per request instead of an SSE stream). Stateful mode keeps a
  `sessionId → transport` map: an `initialize` POST with no `mcp-session-id`
  builds a fresh `buildDocsServer()` + transport
  (`sessionIdGenerator: () => crypto.randomUUID()`) and registers it from
  `onsessioninitialized`; later requests look their transport up by header
  (404 on an unknown id). Stateless mode builds a throwaway server+transport
  **per request** — the SDK's transport refuses reuse, to avoid message-id
  collisions between clients — closed via `closeWhenDone()` once the response
  body has drained *or the client hangs up* (it mirrors the body through a
  `ReadableStream` rather than a `TransformStream` precisely to catch the
  second case). `Bun.serve` runs with `idleTimeout: 0` because SSE streams
  sit idle between server→client messages. Key-free and `@/core`-free like the
  stdio entries; diagnostics on stderr.
  **Two things keep the endpoint local**, since it is unauthenticated and
  serves files: it binds `127.0.0.1` (`Bun.serve` would otherwise listen on
  every interface), and a request carrying an `Origin` header is refused
  unless that origin is loopback — a browser page can rebind DNS to
  127.0.0.1, so binding alone isn't enough. A missing `Origin` (curl, the MCP
  SDK) passes. Stateful sessions also carry a `lastSeen` stamp and are swept
  after 10 minutes idle, closing transport *and* server: a client that
  disappears without a DELETE would otherwise pin both forever.
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
  servers `--mcp` can spawn (mirrors `BUILTIN_TOOLS`/`selectTools`). It lists
  **stdio** servers only — `--mcp-url` addresses a running server by URL, so
  there is nothing to register.

### `client/`

- `connection.ts` — `connectMcpServer(spec)` spawns one server over
  `StdioClientTransport` and returns `{ name, client, alive, close }`;
  `connectMcpServerHttp(name, url)` returns the same shape for an
  already-running StreamableHTTP server (`StreamableHTTPClientTransport`,
  `--mcp-url`). Both go through the same three internals — `createMcpClient()`
  (advertises `capabilities: { sampling: {}, roots: { listChanged: false } }`
  and installs the sampling **and** roots handlers before connecting),
  `handshake()` (10s timeout, failures wrapped as `McpConnectError`), and
  `trackConnection()` (the `alive` flag + one-shot warning on mid-session
  death) — so the two transports can't drift apart.
  `connectMcpServers(specs)` connects several stdio servers (loud-fail: close
  the opened ones and rethrow if any fails). `connectDocsServer()` is the
  docs-only shorthand the demo uses.
- `roots.ts` — `installRootsHandler(client)` registers a handler for
  `roots/list`: it answers with the repo's `docs/` dir (resolved from
  `process.cwd()`, `pathToFileURL`-encoded) as a single `file://` root named
  `"docs"`. The contract is "root === the docs dir itself", so the server uses
  the URI directly as its base dir. Advertised as `roots: { listChanged: false }`
  (the docs root is fixed for a session — no change notifications). Imports
  `@/core` only for `Debug`.
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

### `bun run mcp:http-server` (docs server over HTTP)

Serves `buildDocsServer()` at `http://localhost:3100/mcp` until Ctrl+C.
`--port <n>`, `--stateless`, `--json-response` (see `servers/` above; the
mode is echoed on stderr at startup, along with the `--mcp-url` line to
paste). Connect the main CLI to it, or point the MCP inspector at the URL:

```bash
bun run mcp:http-server &                              # stateful (default)
bun run dev --mcp-url http://localhost:3100/mcp        # tools, #prompts, @mentions
bun run mcp:http-server --port 3101 --stateless        # no server->client channel
```

### `--mcp` / `--mcp-url` on the main CLI (`bun run dev --mcp`)

`--mcp` connects **all registered servers** at startup; `--mcp docs,research`
selects a named subset (same heuristic as `--tools`). `--mcp-url <url>`
(repeatable, http(s) validated at parse time) adds an already-running
StreamableHTTP server; its connection name is the URL's `host/path`, which is
what the `[server]` labels show. The two flags combine and land in **one**
connection list in `runCli`, so nothing downstream distinguishes them.
Failure to start/reach any server is a loud exit 1 (no silent degradation);
every connection is closed in `runCli`'s `finally`. Tools from all servers are
loaded and merged into one set. Three affordances, all implemented in
`cli/mcp-turn.ts` on top of this module's exports, and all **multiplexed
across servers**:

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

- **stdout purity (servers)**: a stdio server's stdout *is* the JSON-RPC
  stream. Any `console.log` corrupts it — diagnostics go to stderr only.
  The HTTP entry doesn't share that constraint (its JSON-RPC rides HTTP
  bodies and SSE), but keeps the habit, and the constraint still binds
  `buildDocsServer()` itself, which both entries share. Servers also must
  not import `@/core` (no API key, faithful "external server" stand-in).
  The corollary: a server that needs the model uses **sampling** instead of
  calling it directly.
- **Server entries own their transport, and only when run as the entry.**
  A file that both exports a factory and hooks up a transport must guard the
  hookup with `import.meta.main` (see `docs-server.ts`), or importing the
  factory silently attaches a transport to the importer's process.
- **Sampling lives client-side, and only there imports `@/core`.**
  `client/sampling.ts` is the one MCP file that touches the Anthropic
  client: it answers `sampling/createMessage` with a `SAMPLING_MODEL`
  (Haiku) one-shot. The connection must advertise
  `capabilities: { sampling: {} }` *and* `installSamplingHandler` before
  `client.connect`, or servers' `createMessage` calls error. Keep model
  defaults (incl. `SAMPLING_MODEL`) in `core/constants.ts`.
- **Roots resolution is lazy + cached, and must never run at module load.**
  The connection advertises `roots: { listChanged: false }` and installs
  `installRootsHandler` before `client.connect` (parallel to sampling). The
  docs server's `resolveDocsDir()` may only call `server.server.listRoots()`
  *after* the handshake — so it runs lazily from tool/resource callbacks,
  never at top level, gated on `getClientCapabilities()?.roots`. The
  standalone/inspector path advertises no `roots` capability, and a stateless
  HTTP session has no channel to ask over, so the hardcoded
  `FALLBACK_DOCS_DIR` is required, not optional. The cache is per server
  instance, since each HTTP session has its own client to ask.
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
  The REPL merges `--tools` and every `--mcp`/`--mcp-url` server's tool set
  into one list and throws on duplicate names (the API 400s otherwise). Pick
  distinct names when adding server tools (`research`, `list_docs`, … are
  taken). Note the easy self-collision: `--mcp docs` plus `--mcp-url` pointed
  at `mcp:http-server` is the *same* server twice, and throws.
- **Failure surface**: startup problems throw `McpConnectError`
  (`connectMcpServers` closes any already-opened connections and rethrows,
  and `runCli` closes whatever opened before a failing `--mcp-url`;
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

To serve it over HTTP too, split it the way `docs-server.ts` does: a
`build<Name>Server()` factory with every registration, an
`import.meta.main`-guarded stdio tail, and a sibling HTTP entry that reuses
the factory. `--mcp-url` needs no registry entry — the URL is the address.

## Adding a capability to a server

Register it in the server file (`registerTool` / `registerPrompt` /
`registerResource`, zod schemas, `.describe()` on every field). Tools
should return `{ content: [{ type: "text", text }] }`. Nothing on the
client side needs changing.

The docs-backed capabilities share two helpers in `docs-server.ts`:
`listDocFiles()` (recursive listing; `[]` when the folder is missing) and
`docPath()` (rejects paths that resolve outside the docs dir). Both await
`resolveDocsDir()`, which discovers the base dir from the client's `roots`
(hardcoded fallback otherwise) and caches it — so both are `async`. New
file-serving capabilities should go through them rather than calling
`readFile` with model-supplied paths directly.
