/**
 * Research MCP server, spoken to over stdio. Spawned as a child process by
 * `connectMcpServer()` (`bun run src/mcp/servers/research-server.ts`), or run
 * standalone for inspection (`bun run mcp:research-server`, or via
 * `bunx @modelcontextprotocol/inspector`).
 *
 * Like `docs-server.ts`, it deliberately does NOT import `@/core` — it holds
 * no Anthropic API key. The `research` tool fetches a full Wikipedia article
 * and then uses **MCP sampling** (`sampling/createMessage`) to ask the
 * *client* to summarize it: the server requests the model run, the client
 * (which has the key) performs it and returns the summary. That round-trip is
 * the whole point — a server doing model work without ever holding a key.
 *
 * stdout carries the JSON-RPC stream, so nothing may ever write to it;
 * diagnostics go to stderr only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Wikipedia asks API clients to send a descriptive User-Agent. */
const USER_AGENT =
  "testing-anthropic-research/0.1 (MCP sampling demo; https://github.com/Mgrdich)";

/** Hard cap on the article text we feed into the sampling request. */
const MAX_EXTRACT_CHARS = 10_000;

/**
 * Fetch the plain-text extract of a Wikipedia article by title. Returns the
 * extract (truncated) or throws with a readable message when the page is
 * missing or the request fails.
 */
async function fetchWikipediaExtract(topic: string) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
    format: "json",
    titles: topic,
  }).toString();

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Wikipedia request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    query?: { pages?: Record<string, { extract?: string; missing?: string }> };
  };
  const pages = data.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined || !page.extract?.trim()) {
    throw new Error(`no Wikipedia article found for "${topic}"`);
  }
  return page.extract.slice(0, MAX_EXTRACT_CHARS);
}

/** Pull plain text out of a sampling result's content (single block or array). */
function sampledText(content: CreateMessageResult["content"]) {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

const server = new McpServer({
  name: "testing-anthropic-research",
  version: "0.1.0",
});

server.registerTool(
  "research",
  {
    description:
      "Research a topic: fetch the Wikipedia article and return a concise summary. The summarization runs on the client via MCP sampling.",
    inputSchema: {
      topic: z
        .string()
        .describe("The subject to research, e.g. 'Eiffel Tower'"),
    },
  },
  async ({ topic }) => {
    let extract: string;
    try {
      extract = await fetchWikipediaExtract(topic);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `could not research '${topic}': ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    // Ask the client to summarize via sampling. `McpServer` exposes the
    // low-level server (which carries `createMessage`) as `.server`.
    try {
      const result = await server.server.createMessage({
        systemPrompt:
          "You are a research assistant. Summarize the provided article faithfully and concisely.",
        maxTokens: 512,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Summarize the following article about "${topic}" in one tight paragraph:\n\n${extract}`,
            },
          },
        ],
      });
      const summary = sampledText(result.content);
      if (summary) {
        return { content: [{ type: "text", text: summary }] };
      }
      process.stderr.write(
        "[research] sampling returned no text; falling back to raw extract\n",
      );
    } catch (err) {
      process.stderr.write(
        `[research] sampling failed (${err instanceof Error ? err.message : String(err)}); falling back to raw extract\n`,
      );
    }

    // Fallback (client without sampling, or an empty/failed sample): hand back
    // the fetched text so the agentic loop still has something to work with.
    return {
      content: [
        {
          type: "text",
          text: `(could not summarize via sampling; raw Wikipedia extract for "${topic}")\n\n${extract}`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
