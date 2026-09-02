/**
 * The docs MCP server: `buildDocsServer()` registers every capability, and
 * this file's tail is the **stdio** entry that serves it over
 * `StdioServerTransport`. Spawned as a child process by `connectMcpServer()`
 * (`bun run src/mcp/servers/docs-server.ts`), or run standalone for
 * inspection (`bun run mcp:server`, or via
 * `bunx @modelcontextprotocol/inspector`).
 *
 * The factory is exported so a second transport can serve the identical
 * surface: `http-docs-server.ts` builds one server per HTTP session
 * (`bun run mcp:http-server`). The stdio hookup below is guarded by
 * `import.meta.main`, so importing the factory never hijacks stdio.
 *
 * Deliberately does NOT import `@/core` — the server needs no Anthropic API
 * key, and keeping it dependency-free makes it a faithful "external server"
 * stand-in. On the stdio path stdout carries the JSON-RPC stream, so nothing
 * may ever write to it; diagnostics go to stderr only.
 *
 * Exposes all three MCP primitives, grounded in the repo's `docs/` folder
 * (gitignored; populated by the rag walkthrough — empty/missing is handled
 * gracefully), so the client side can exercise the Anthropic SDK's full
 * `helpers/beta/mcp` surface:
 *   tools     — list_docs, read_doc (non-mutating, names chosen not to
 *               collide with the built-ins in core/tools)
 *   prompt    — explain_topic (XML-tagged template, matching the rag style)
 *   resources — docs://{+path} (templated; `list` enumerates every file in
 *               docs/, reading resolves one item)
 */
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Fallback docs dir when no roots-capable client advertised one. Via
 * `fileURLToPath`, not `URL.pathname` — the latter stays percent-encoded, so a
 * checkout under a path with a space would resolve to the wrong directory.
 */
const FALLBACK_DOCS_DIR = resolve(
  fileURLToPath(new URL("../../../docs", import.meta.url)),
);

function mimeFor(path: string) {
  return path.endsWith(".md") ? "text/markdown" : "text/plain";
}

/**
 * Build a fully-registered docs server. Every tool / prompt / resource lives
 * here, so both transports (stdio below, StreamableHTTP in
 * `http-docs-server.ts`) serve exactly the same surface.
 *
 * Each call returns an independent `McpServer` with its own docs-dir cache —
 * the HTTP server builds one per session, and roots are a per-client answer,
 * so the cache must not be shared across instances.
 */
export function buildDocsServer() {
  const server = new McpServer({
    name: "testing-anthropic-mcp",
    version: "0.1.0",
  });

  let docsDirPromise: Promise<string> | undefined;

  /**
   * Resolve the docs base dir once, then cache it. Prefers a `file://` root
   * the client advertised via `roots/list` (the contract is "root === the
   * docs dir itself"); falls back to FALLBACK_DOCS_DIR when roots are
   * unavailable/empty or the call fails — which is also what a stateless
   * HTTP session gets, since it has no server→client channel. Lazy — must not
   * run before the server has connected, since the client's capabilities
   * aren't known until then. Callers only reach it from tool/resource
   * handlers, which run after `server.connect`.
   */
  function resolveDocsDir(): Promise<string> {
    if (docsDirPromise) return docsDirPromise;
    docsDirPromise = (async () => {
      try {
        if (!server.server.getClientCapabilities()?.roots) {
          return FALLBACK_DOCS_DIR;
        }
        const { roots } = await server.server.listRoots();
        // Match on the root's NAME, not merely on it being a file:// URI.
        // The contract is "root === the docs dir itself", which only a client
        // that knows this server can honor (ours names it "docs" — see
        // `client/roots.ts`). A general-purpose roots-capable client answers
        // with its own *workspace* root instead: the Claude Agent SDK returns
        // the cwd, and serving that verbatim would walk the entire repo,
        // .git and node_modules included. Prefer the fallback over a root
        // that was never meant to be a docs dir.
        const docsRoot = roots.find(
          (r) => r.name === "docs" && r.uri.startsWith("file://"),
        );
        if (docsRoot) return fileURLToPath(docsRoot.uri);
        process.stderr.write(
          `docs-server: no root named "docs" advertised (got ${
            roots.map((r) => r.name ?? r.uri).join(", ") || "none"
          }); using fallback ${FALLBACK_DOCS_DIR}\n`,
        );
        return FALLBACK_DOCS_DIR;
      } catch (err) {
        process.stderr.write(
          `docs-server: roots/list failed, using fallback (${err instanceof Error ? err.message : String(err)})\n`,
        );
        return FALLBACK_DOCS_DIR;
      }
    })();
    return docsDirPromise;
  }

  /** All files under the docs dir, as sorted relative paths. [] if missing. */
  async function listDocFiles() {
    const dir = await resolveDocsDir();
    try {
      const entries = await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => relative(dir, resolve(e.parentPath, e.name)))
        .sort();
    } catch {
      return []; // docs dir doesn't exist yet
    }
  }

  /** Resolve a docs-relative path, refusing anything that escapes docs/. */
  async function docPath(path: string) {
    const dir = await resolveDocsDir();
    const full = resolve(dir, path);
    if (!full.startsWith(dir + sep)) {
      throw new Error(`path escapes the docs folder: ${path}`);
    }
    return full;
  }

  async function readDoc(path: string) {
    return await readFile(await docPath(path), "utf8");
  }

  server.registerTool(
    "list_docs",
    {
      description:
        "List the documents available in the project docs/ folder (relative paths, one per line).",
    },
    async () => {
      const files = await listDocFiles();
      return {
        content: [
          {
            type: "text",
            text: files.length > 0 ? files.join("\n") : "(docs/ is empty)",
          },
        ],
      };
    },
  );

  server.registerTool(
    "read_doc",
    {
      description:
        "Read a document from the project docs/ folder. Use list_docs to discover the available paths.",
      inputSchema: {
        path: z
          .string()
          .describe("Docs-relative path, e.g. northvale-tunnel-collapse.md"),
      },
    },
    async ({ path }) => {
      try {
        return { content: [{ type: "text", text: await readDoc(path) }] };
      } catch (err) {
        const files = await listDocFiles();
        const available =
          files.length > 0
            ? `available: ${files.join(", ")}`
            : "docs/ is empty";
        return {
          content: [
            {
              type: "text",
              text: `could not read '${path}' (${err instanceof Error ? err.message : String(err)}); ${available}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerPrompt(
    "explain_topic",
    {
      description:
        "Build an XML-tagged prompt asking the model to explain a topic for a given audience.",
      argsSchema: {
        topic: z.string().describe("The topic to explain"),
        audience: z
          .string()
          .optional()
          .describe(
            "Who the explanation is for (default: a general technical reader)",
          ),
      },
    },
    ({ topic, audience }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "<task>Explain the topic below for the given audience. Be concise and concrete — a short paragraph, no headings.</task>",
              `<topic>${topic}</topic>`,
              `<audience>${audience ?? "a general technical reader"}</audience>`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerResource(
    "docs",
    new ResourceTemplate("docs://{+path}", {
      list: async () => ({
        resources: (await listDocFiles()).map((path) => ({
          uri: `docs://${path}`,
          name: path,
          description: `Project doc: ${path}`,
          mimeType: mimeFor(path),
        })),
      }),
    }),
    {
      description:
        "Documents from the project docs/ folder; one resource per file.",
    },
    async (uri, variables) => {
      const raw = variables.path;
      const path = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
      const decoded = decodeURIComponent(path);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: mimeFor(decoded),
            text: await readDoc(decoded),
          },
        ],
      };
    },
  );

  return server;
}

// Stdio entry. Guarded so `http-docs-server.ts` (and anything else) can
// import the factory without a transport attaching itself to this process's
// stdio.
if (import.meta.main) {
  await buildDocsServer().connect(new StdioServerTransport());
}
