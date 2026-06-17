/**
 * Client-side MCP **sampling** handler. When a server issues a
 * `sampling/createMessage` request (it wants the model run on its behalf —
 * e.g. the research server asking us to summarize an article), this is the
 * half that actually calls Claude.
 *
 * This is the deliberate counterpart to the servers' "no `@/core`" rule: the
 * servers hold no API key and never call the model directly; the client does,
 * here, through the shared `core` primitives. The connection advertises the
 * `sampling` capability and installs this handler before connecting (see
 * `connection.ts`).
 *
 * Summaries are cheap, so this always uses `SAMPLING_MODEL` (Haiku) and
 * ignores the server's `modelPreferences` — the spec explicitly lets the
 * client choose the model.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CreateMessageRequestSchema,
  type SamplingMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
  addAssistantMessage,
  Debug,
  extractText,
  SAMPLING_MODEL,
} from "@/core/index.ts";

/** Anthropic `stop_reason` → MCP `stopReason` (best-effort; open string). */
function mapStopReason(reason: Anthropic.Message["stop_reason"]) {
  switch (reason) {
    case "end_turn":
      return "endTurn";
    case "max_tokens":
      return "maxTokens";
    case "stop_sequence":
      return "stopSequence";
    case "tool_use":
      return "toolUse";
    default:
      return reason ?? undefined;
  }
}

/**
 * Flatten an MCP `SamplingMessage` to a plain-text `MessageParam`. Sampling
 * content may be a single block or an array; we keep text verbatim and
 * degrade any non-text block to a `[type]` placeholder (the bundled servers
 * only ever sample on text, matching the `Tool` adapter in `tools.ts`).
 */
function toMessageParam(message: SamplingMessage) {
  const blocks = Array.isArray(message.content)
    ? message.content
    : [message.content];
  const text = blocks
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join("\n");
  return { role: message.role, content: text };
}

/**
 * Register the sampling request handler on an MCP `Client`. Pair it with
 * `capabilities: { sampling: {} }` in the `Client` constructor so the server
 * knows sampling is available.
 */
export function installSamplingHandler(client: Client) {
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const params = request.params;
    const messages = params.messages.map(toMessageParam);
    Debug.get().json("mcp sampling", () => ({
      model: SAMPLING_MODEL,
      messages: messages.length,
      maxTokens: params.maxTokens,
      hasSystem: params.systemPrompt !== undefined,
    }));

    const response = await addAssistantMessage([...messages], {
      model: SAMPLING_MODEL,
      max_tokens: params.maxTokens,
      ...(params.systemPrompt !== undefined
        ? { system: params.systemPrompt }
        : {}),
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
      ...(params.stopSequences !== undefined
        ? { stop_sequences: params.stopSequences }
        : {}),
    });

    return {
      model: SAMPLING_MODEL,
      role: "assistant",
      content: { type: "text", text: extractText(response.content) },
      stopReason: mapStopReason(response.stop_reason),
    };
  });
}
