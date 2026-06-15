# `src/mcp/`

MCP (Model Context Protocol) server + client. The server is a stand-in for
any external MCP server; the client side converts its tools, prompts, and
resources for Claude using the **Anthropic SDK's MCP helpers**
(`@anthropic-ai/sdk/helpers/beta/mcp`) — conversion is never hand-rolled
here.

CLI entries: `bun run mcp` (the demo, `cli.ts`) and `bun run mcp:server`
(the server standalone, `server.ts`). The module also plugs into the main
`bun run dev` CLI via the `--mcp` flag — see the CLI section below.
Public API is re-exported from `src/mcp/index.ts`.

## Layout

- `server.ts` — standalone stdio server entry (`bun run mcp:server`), built
  with `@modelcontextprotocol/sdk` and grounded in the repo's gitignored
  `docs/` folder (populated by the rag walkthrough; missing/empty docs/
  degrades gracefully). Registers `list_docs` and `read_doc` tools (the
  latter path-traversal-guarded to `docs/`), the XML-tagged
  `explain_topic` prompt, and a `docs://{+path}` resource template — its
  `list` callback enumerates every file in `docs/`; reading resolves one
  item.
- `client.ts` — `connectLocalMcp()` spawns `server.ts` as a child process
  over `StdioClientTransport` and returns `{ client, alive, close }`.
- `tools.ts` — `mcpRunnableTools()` (the shared guard-then-convert step:
  `isMcpClientLike` narrow → SDK `mcpTools()`; also used by `cli.ts`) and
  `loadMcpTools()`: `listTools()` → `mcpRunnableTools()` → adapt each
  `BetaRunnableTool` to the local `Tool` shape from `core/tools`.
- `prompts.ts` — `listMcpPrompts()` / `getPromptMessages()` (SDK
  `mcpMessages()`), backing the REPL's `#` prompt commands.
- `resources.ts` — `listMcpResources()` / `readResourceBlock()` (SDK
  `mcpResourceToContent()`) / `resourceBlockText()`, backing the REPL's
  `@` mentions.
- `cli.ts` — `bun run mcp` showcase; uses the SDK helpers natively (no
  local-Tool adapter) against the live API.
- `index.ts` — barrel. `server.ts` and `cli.ts` are entries, not exports.

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

### `bun run mcp:server` (server standalone, `server.ts`)

Starts the stdio server and idles waiting for a JSON-RPC client; Ctrl+C
to exit. Mainly useful with inspector tooling:
`bunx @modelcontextprotocol/inspector bun run src/mcp/server.ts`. Not
needed for `bun run mcp` / `--mcp` — those spawn their own child.

### `--mcp` on the main CLI (`bun run dev --mcp`)

Connects at startup (failure = loud exit 1, no silent degradation) and
closes the connection in `runCli`'s `finally`. Three affordances, all
implemented in `cli/repl.ts` on top of this module's exports:

- **Tools** — the server's tools merge into the agentic loop. Works
  alone (`--mcp` = MCP tools only) or combined with `--tools`
  (duplicate names throw), under both `--runner local` and
  `--runner sdk`.
- **`#` prompt commands → prompts** — `#prompts` (or `#help`) lists the
  server's prompts to stderr; `#<name> key=value key="multi word"`
  fetches the prompt via `getPromptMessages` and appends its messages
  to history before the normal send. Unknown prompt / dead server →
  stderr error, no API call. (`/` is reserved for future REPL commands;
  the sigil is the `PROMPT_PREFIX` constant in `cli/mcp-turn.ts`.)
- **`@` mentions → resources** — `@<name>` (a docs-relative path,
  resolved against `listResources`, e.g.
  `@northvale-tunnel-collapse.md`) or `@<uri>` (e.g.
  `@docs://northvale-tunnel-collapse.md`) fetches via
  `readResourceBlock` and attaches each resource as an XML-tagged
  (`<resource uri="…">…</resource>`) content block ahead of the user
  text. Unresolvable mentions warn and stay literal.

Piped stdin exercises the same paths single-shot
(`echo '#prompts' | bun run dev --mcp`). With `--debug`, the module adds
`mcp connect` / `mcp server info` / `mcp tools` / `mcp prompt` /
`mcp resource` frames to the existing agentic traces.

## Invariants

- **stdout purity (server)**: `server.ts`'s stdout *is* the JSON-RPC
  stream. Any `console.log` corrupts it — diagnostics go to stderr only.
  The server also must not import `@/core` (no API key, faithful
  "external server" stand-in).
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
- **Tool names must not collide with built-ins.** The REPL merges
  `--tools` and `--mcp` tool sets and throws on duplicate names (the API
  400s otherwise). Pick distinct names when adding server tools.
- **Failure surface**: startup problems throw `McpConnectError` (callers
  print + exit non-zero); mid-session server death flips
  `McpConnection.alive` (checked by the REPL's prompt/mention paths) and
  warns once on stderr. Tool calls against a dead server surface as
  normal tool errors through the agentic loop's parse → run → catch.

## Adding a server capability

Register it in `server.ts` (`registerTool` / `registerPrompt` /
`registerResource`, zod schemas, `.describe()` on every field). Tools
should return `{ content: [{ type: "text", text }] }`. Nothing on the
client side needs changing — tools/prompts/resources are discovered via
`list*()` at connect time.

The docs-backed capabilities share two helpers in `server.ts`:
`listDocFiles()` (recursive `docs/` listing; `[]` when the folder is
missing) and `docPath()` (rejects paths that resolve outside `docs/`).
New file-serving capabilities should go through them rather than calling
`readFile` with model-supplied paths directly.
