import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";

export type MessageParam = Anthropic.MessageParam;

export type AddAssistantOptions = Partial<
  Omit<Anthropic.MessageCreateParamsNonStreaming, "messages" | "stream">
>;

export type StreamAssistantOptions = Partial<
  Omit<Anthropic.MessageStreamParams, "messages">
>;

export function addUserMessage(messages: MessageParam[], text: string): void {
  messages.push({ role: "user", content: text });
}

export async function addAssistantMessage(
  client: Anthropic,
  messages: MessageParam[],
  opts: AddAssistantOptions = {},
): Promise<Anthropic.Message> {
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...opts,
    messages,
  });

  messages.push({ role: "assistant", content: response.content });
  return response;
}

export async function streamAssistantMessage(
  client: Anthropic,
  messages: MessageParam[],
  opts: StreamAssistantOptions = {},
  onTextDelta?: (delta: string) => void,
): Promise<Anthropic.Message> {
  const stream = client.messages.stream({
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...opts,
    messages,
  });

  if (onTextDelta) {
    stream.on("text", (delta) => onTextDelta(delta));
  }

  const finalMessage = await stream.finalMessage();
  messages.push({ role: "assistant", content: finalMessage.content });
  return finalMessage;
}
