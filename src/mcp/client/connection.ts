import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Debug, errMsg } from "@/core/index.ts";
import { installSamplingHandler } from "@/mcp/client/sampling.ts";
import { MCP_SERVERS, type McpServerSpec } from "@/mcp/servers/index.ts";

/** Thrown when a local MCP server can't be spawned or won't handshake. */
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
 * Spawn one registered stdio MCP server as a child process and connect to it.
 * The client advertises the `sampling` capability and installs the sampling
 * handler (see `sampling.ts`) before connecting, so a server can ask us to
 * run the model on its behalf. Throws `McpConnectError` if the spawn or the
 * MCP handshake fails (or times out).
 */
export async function connectMcpServer(
  spec: McpServerSpec,
): Promise<McpConnection> {
  // Annotated: the literal's `get alive()` must publish as the readonly
  // `alive` of the McpConnection contract, not a structural one-off.
  const dbg = Debug.get();
  dbg.json("mcp connect", {
    server: spec.name,
    command: "bun",
    args: ["run", spec.scriptPath],
  });

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", spec.scriptPath],
    stderr: "inherit", // server diagnostics surface on our stderr
  });
  const client = new Client(
    { name: "testing-anthropic", version: "0.1.0" },
    { capabilities: { sampling: {} } },
  );
  installSamplingHandler(client);

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
      `could not connect to MCP server '${spec.name}' (bun run ${spec.scriptPath}): ${errMsg(err)}`,
      err,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  dbg.json("mcp server info", () => client.getServerVersion() ?? {});

  // Track mid-session death so callers can degrade gracefully instead of
  // hitting opaque transport errors. `closing` suppresses the warning when
  // the shutdown is ours.
  let alive = true;
  let closing = false;
  client.onclose = () => {
    alive = false;
    if (!closing) {
      process.stderr.write(
        `warning: MCP server '${spec.name}' exited — its tools/prompts/resources are unavailable for the rest of the session\n`,
      );
    }
  };
  client.onerror = (err) => {
    dbg.json("mcp client error", { server: spec.name, message: errMsg(err) });
  };

  return {
    name: spec.name,
    client,
    get alive() {
      return alive;
    },
    close: async () => {
      closing = true;
      await client.close();
    },
  };
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
