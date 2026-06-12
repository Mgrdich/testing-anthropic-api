import { mcpResourceToContent } from "@anthropic-ai/sdk/helpers/beta/mcp";
import type {
  BetaImageBlockParam,
  BetaRequestDocumentBlock,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Debug } from "@/core/index.ts";

export type McpResourceBlock =
  | BetaTextBlockParam
  | BetaImageBlockParam
  | BetaRequestDocumentBlock;

/**
 * Extract plain text from a converted resource block, if it carries any.
 * `mcpResourceToContent` maps `text/*` resources to a document block with a
 * plain-text source (not a text block), so both shapes must be handled.
 */
export function resourceBlockText(block: McpResourceBlock) {
  if (block.type === "text") return block.text;
  if (block.type === "document" && block.source.type === "text") {
    return block.source.data;
  }
  return undefined;
}

export type McpResourceInfo = {
  name: string;
  uri: string;
  description?: string;
};

/** List the server's (non-templated) resources, for `@name` resolution. */
export async function listMcpResources(client: Client) {
  const { resources } = await client.listResources();
  return resources.map((r) => ({
    name: r.name,
    uri: r.uri,
    ...(r.description !== undefined ? { description: r.description } : {}),
  }));
}

/**
 * Read a resource by full URI (`docs://northvale-tunnel-collapse.md`) or
 * bare name (resolved against `listResources`) and convert it to an Anthropic
 * content block via the SDK's `mcpResourceToContent()` helper. Throws on
 * unknown names so callers can warn and keep the mention as literal text.
 */
export async function readResourceBlock(
  client: Client,
  ref: string,
) {
  let uri = ref;
  if (!ref.includes("://")) {
    const resources = await listMcpResources(client);
    const match = resources.find((r) => r.name === ref);
    if (!match) {
      const known = resources.map((r) => `${r.name} (${r.uri})`).join(", ");
      throw new Error(`unknown resource '${ref}' — known: ${known || "none"}`);
    }
    uri = match.uri;
  }
  const result = await client.readResource({ uri });
  Debug.get().json("mcp resource", { ref, uri });
  return { uri, block: mcpResourceToContent(result) };
}
