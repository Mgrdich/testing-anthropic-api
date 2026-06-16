import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Debug, errMsg } from "@/core/index.ts";

/** Thrown when the local MCP server can't be spawned or won't handshake. */
export class McpConnectError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "McpConnectError";
  }
}

export type McpConnection = {
  client: Client;
  /** False once the server process / transport has gone away mid-session. */
  readonly alive: boolean;
  close: () => Promise<void>;
};

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Spawn the bundled stdio MCP server (`src/mcp/server.ts`) as a child
 * process and connect to it. The server path is resolved relative to this
 * file so it works regardless of cwd. Throws `McpConnectError` if the spawn
 * or the MCP handshake fails (or times out).
 */
export async function connectLocalMcp(): Promise<McpConnection> {
  // Annotated: the literal's `get alive()` must publish as the readonly
  // `alive` of the McpConnection contract, not a structural one-off.
  const dbg = Debug.get();
  const serverPath = new URL("./server.ts", import.meta.url).pathname;
  dbg.json("mcp connect", { command: "bun", args: ["run", serverPath] });

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", serverPath],
    stderr: "inherit", // server diagnostics surface on our stderr
  });
  const client = new Client({ name: "testing-anthropic", version: "0.1.0" });

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
      `could not connect to MCP server (bun run ${serverPath}): ${errMsg(err)}`,
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
        "warning: MCP server exited — MCP tools/prompts/resources unavailable for the rest of the session\n",
      );
    }
  };
  client.onerror = (err) => {
    dbg.json("mcp client error", { message: errMsg(err) });
  };

  return {
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
