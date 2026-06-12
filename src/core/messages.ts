import type Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { AnthropicClient } from "@/core/client.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";

export type MessageParam = Anthropic.MessageParam;

export type AddAssistantOptions = Partial<
  Omit<Anthropic.MessageCreateParamsNonStreaming, "messages" | "stream">
>;

export type StreamAssistantOptions = Partial<
  Omit<Anthropic.MessageStreamParams, "messages">
>;

export function addUserMessage(messages: MessageParam[], text: string) {
  messages.push({ role: "user", content: text });
}

/**
 * Concatenate every text block in an assistant message's content into a
 * single string. Non-text blocks (tool_use, etc.) are ignored. For
 * single-block responses this is equivalent to `content[0].text`.
 */
export function extractText(content: Anthropic.Message["content"]) {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
}

function withPrefill(
  messages: MessageParam[],
  prefill: string | undefined,
): MessageParam[] {
  return prefill
    ? [...messages, { role: "assistant", content: prefill }]
    : messages;
}

function mergePrefillIntoContent(
  prefill: string,
  content: Anthropic.Message["content"],
) {
  const first = content[0];
  if (!first || first.type !== "text") return content;
  return [{ ...first, text: prefill + first.text }, ...content.slice(1)];
}

export async function addAssistantMessage(
  messages: MessageParam[],
  opts: AddAssistantOptions = {},
  prefill?: string,
) {
  const response = await AnthropicClient.get().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...opts,
    messages: withPrefill(messages, prefill),
  });

  const merged = prefill
    ? mergePrefillIntoContent(prefill, response.content)
    : response.content;
  messages.push({ role: "assistant", content: merged });
  return response;
}

export async function streamAssistantMessage(
  messages: MessageParam[],
  opts: StreamAssistantOptions = {},
  onStream?: (stream: MessageStream) => void,
  prefill?: string,
) {
  const stream = AnthropicClient.get().messages.stream({
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...opts,
    messages: withPrefill(messages, prefill),
  });

  onStream?.(stream);

  const finalMessage = await stream.finalMessage();
  const merged = prefill
    ? mergePrefillIntoContent(prefill, finalMessage.content)
    : finalMessage.content;
  messages.push({ role: "assistant", content: merged });
  return finalMessage;
}
