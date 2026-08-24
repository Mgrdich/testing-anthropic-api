import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Debug, errMsg } from "@/core/index.ts";
import { installRootsHandler } from "@/mcp/client/roots.ts";
import { installSamplingHandler } from "@/mcp/client/sampling.ts";
import { MCP_SERVERS, type McpServerSpec } from "@/mcp/servers/index.ts";

/** Thrown when an MCP server can't be reached or won't handshake. */
export class McpConnectError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "McpConnectError";
  }
}

export type McpConnection = {
  /** The registry id of the server this connection talks to. */
  name: string;
  client: Client;
  /** False once the server process / transport has gone away mid-session. */
  readonly alive: boolean;
  close: () => Promise<void>;
};

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A client that advertises the `sampling` and `roots` capabilities with both
 * handlers installed (see `sampling.ts` / `roots.ts`), so a server can ask us
 * to run the model on its behalf and discover which filesystem roots it may
 * serve from. Transport-independent: stdio and StreamableHTTP get the exact
 * same client, which is why an HTTP server needs no code of its own to use
 * sampling — only a session (see `src/mcp/servers/http-docs-server.ts`).
 */
function createMcpClient() {
  const client = new Client(
    { name: "testing-anthropic", version: "0.1.0" },
    { capabilities: { sampling: {}, roots: { listChanged: false } } },
  );
  installSamplingHandler(client);
  installRootsHandler(client);
  return client;
}

/**
 * Connect with a timeout, translating any failure into `McpConnectError`
 * (closing the half-open client first). `describe` names the server the way
 * the user asked for it, so the error points at the flag they typed.
 */
async function handshake(
  client: Client,
  transport: Transport,
  describe: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`handshake timed out after ${CONNECT_TIMEOUT_MS}ms`),
            ),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    await client.close().catch(() => {});
    throw new McpConnectError(
      `could not connect to ${describe}: ${errMsg(err)}`,
      err,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  Debug.get().json("mcp server info", () => client.getServerVersion() ?? {});
}

/**
 * Wrap a connected client in the `McpConnection` contract, tracking
 * mid-session death so callers can degrade gracefully instead of hitting
 * opaque transport errors. `closing` suppresses the warning when the shutdown
 * is ours; `gone` is the past-tense phrase for how this transport dies
 * (a child process exits, an HTTP session drops).
 */
function trackConnection(name: string, client: Client, gone: string) {
  // Annotated: the literal's `get alive()` must publish as the readonly
  // `alive` of the McpConnection contract, not a structural one-off.
  let alive = true;
  let closing = false;
  client.onclose = () => {
    alive = false;
    if (!closing) {
      process.stderr.write(
        `warning: ${gone} — its tools/prompts/resources are unavailable for the rest of the session\n`,
      );
    }
  };
  client.onerror = (err) => {
    Debug.get().json("mcp client error", {
      server: name,
      message: errMsg(err),
    });
  };

  const connection: McpConnection = {
    name,
    client,
    get alive() {
      return alive;
    },
    close: async () => {
      closing = true;
      await client.close();
    },
  };
  return connection;
}

/**
 * Spawn one registered stdio MCP server as a child process and connect to it.
 * Throws `McpConnectError` if the spawn or the MCP handshake fails (or times
 * out).
 */
export async function connectMcpServer(
  spec: McpServerSpec,
): Promise<McpConnection> {
  Debug.get().json("mcp connect", {
    server: spec.name,
    transport: "stdio",
    command: "bun",
    args: ["run", spec.scriptPath],
  });

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", spec.scriptPath],
    stderr: "inherit", // server diagnostics surface on our stderr
  });
  const client = createMcpClient();
  await handshake(
    client,
    transport,
    `MCP server '${spec.name}' (bun run ${spec.scriptPath})`,
  );
  return trackConnection(spec.name, client, `MCP server '${spec.name}' exited`);
}

/**
 * Connect to a **StreamableHTTP** MCP server by URL (`--mcp-url`) — the same
 * `McpConnection` the stdio path returns, so everything downstream (tools,
 * prompts, resources, the agentic loop) is transport-agnostic. Nothing is
 * spawned: the server is already running, ours or someone else's.
 *
 * The client is identical to the stdio one, sampling and roots handlers
 * included. Whether the server can actually *use* them is the server's call:
 * a stateful session has the server→client SSE stream those requests travel
 * on, a stateless one does not, and the servers fall back gracefully (see
 * `servers/http-docs-server.ts`).
 */
export async function connectMcpServerHttp(
  name: string,
  url: string,
): Promise<McpConnection> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch (err) {
    throw new McpConnectError(`invalid MCP server URL '${url}'`, err);
  }
  Debug.get().json("mcp connect", {
    server: name,
    transport: "http",
    url: endpoint.href,
  });

  const client = createMcpClient();
  await handshake(
    client,
    new StreamableHTTPClientTransport(endpoint),
    `MCP server '${name}' (${endpoint.href})`,
  );
  return trackConnection(
    name,
    client,
    `MCP server '${name}' (${endpoint.href}) disconnected`,
  );
}

/**
 * Connect several MCP servers, preserving the loud-fail contract: if any one
 * fails to start, the connections already opened are closed and the original
 * `McpConnectError` is rethrown (no partial, half-degraded session).
 */
export async function connectMcpServers(specs: McpServerSpec[]) {
  const opened: McpConnection[] = [];
  try {
    for (const spec of specs) {
      opened.push(await connectMcpServer(spec));
    }
  } catch (err) {
    await Promise.all(opened.map((c) => c.close().catch(() => {})));
    throw err;
  }
  return opened;
}

/** Connect just the docs server — the single connection the `bun run mcp` demo uses. */
export function connectDocsServer() {
  const docs = MCP_SERVERS.docs;
  if (!docs) throw new Error("docs server is not registered");
  return connectMcpServer(docs);
}
