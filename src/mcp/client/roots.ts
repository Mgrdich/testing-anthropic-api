/**
 * Client-side MCP **roots** handler. When a server issues a `roots/list`
 * request (it wants to know which filesystem roots the client has granted),
 * this answers with the single root the bundled servers care about: the
 * repo's `docs/` directory.
 *
 * Counterpart to `sampling.ts`: the connection advertises the `roots`
 * capability and installs this handler before connecting (see
 * `connection.ts`), so a server can discover where it should serve from
 * instead of hardcoding a path. The contract is "root === the docs dir
 * itself" — the server uses the root URI directly as its base directory.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Debug } from "@/core/index.ts";

/** The repo's docs/ dir as a `file://` URI (cwd is the repo root). */
function docsRootUri() {
  // pathToFileURL percent-encodes spaces/special chars for us.
  return pathToFileURL(resolve(process.cwd(), "docs")).href;
}

/**
 * Register the `roots/list` request handler on an MCP `Client`. Pair it with
 * `capabilities: { roots: { listChanged: false } }` in the `Client`
 * constructor so the server knows roots are available. The root never changes
 * during a session, so we neither advertise nor emit `list_changed`.
 */
export function installRootsHandler(client: Client) {
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    const uri = docsRootUri();
    Debug.get().json("mcp roots", { uri });
    return { roots: [{ uri, name: "docs" }] };
  });
}
