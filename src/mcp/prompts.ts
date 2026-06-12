import { mcpMessages } from "@anthropic-ai/sdk/helpers/beta/mcp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Debug, type MessageParam } from "@/core/index.ts";

export type McpPromptInfo = {
  name: string;
  description?: string;
  /** Argument names; `?` suffix marks optional ones. */
  args: string[];
};

/** List the server's prompts (for `/prompts` and slash-command validation). */
export async function listMcpPrompts(client: Client) {
  const { prompts } = await client.listPrompts();
  return prompts.map((p) => ({
    name: p.name,
    ...(p.description !== undefined ? { description: p.description } : {}),
    args: (p.arguments ?? []).map(
      (a) => (a.required ? a.name : `${a.name}?`),
    ),
  }));
}

/**
 * Fetch a prompt from the server and convert its messages for our history
 * via the Anthropic SDK's `mcpMessages()` helper. The returned messages are
 * ready to push onto the shared `messages: MessageParam[]` array (one cast
 * at the beta → non-beta wire boundary; the JSON shapes are identical for
 * text content).
 */
export async function getPromptMessages(
  client: Client,
  name: string,
  args: Record<string, string>,
) {
  const prompt = await client.getPrompt({ name, arguments: args });
  Debug.get().json("mcp prompt", () => ({
    name,
    args,
    messages: prompt.messages.length,
  }));
  return mcpMessages(prompt.messages) as unknown as MessageParam[];
}
