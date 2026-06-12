/**
 * Local MCP server, spoken to over stdio. Spawned as a child process by
 * `connectLocalMcp()` (`bun run src/mcp/server.ts`), or run standalone for
 * inspection (`bun run mcp:server`, or via `bunx @modelcontextprotocol/inspector`).
 *
 * Deliberately does NOT import `@/core` — the server needs no Anthropic API
 * key, and keeping it dependency-free makes it a faithful "external server"
 * stand-in. stdout carries the JSON-RPC stream, so nothing may ever write to
 * it; diagnostics go to stderr only.
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
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DOCS_DIR = resolve(new URL("../../docs", import.meta.url).pathname);

function mimeFor(path: string) {
  return path.endsWith(".md") ? "text/markdown" : "text/plain";
}

/** All files under docs/, as sorted docs-relative paths. [] if docs/ is missing. */
async function listDocFiles() {
  try {
    const entries = await readdir(DOCS_DIR, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => relative(DOCS_DIR, resolve(e.parentPath, e.name)))
      .sort();
  } catch {
    return []; // docs/ doesn't exist yet
  }
}

/** Resolve a docs-relative path, refusing anything that escapes DOCS_DIR. */
function docPath(path: string) {
  const full = resolve(DOCS_DIR, path);
  if (!full.startsWith(DOCS_DIR + sep)) {
    throw new Error(`path escapes the docs folder: ${path}`);
  }
  return full;
}

async function readDoc(path: string) {
  return await readFile(docPath(path), "utf8");
}

const server = new McpServer({
  name: "testing-anthropic-mcp",
  version: "0.1.0",
});

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
        .describe(
          "Docs-relative path, e.g. northvale-tunnel-collapse.md",
        ),
    },
  },
  async ({ path }) => {
    try {
      return { content: [{ type: "text", text: await readDoc(path) }] };
    } catch (err) {
      const files = await listDocFiles();
      const available =
        files.length > 0 ? `available: ${files.join(", ")}` : "docs/ is empty";
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
        .describe("Who the explanation is for (default: a general technical reader)"),
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
    const raw = variables["path"];
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

await server.connect(new StdioServerTransport());
