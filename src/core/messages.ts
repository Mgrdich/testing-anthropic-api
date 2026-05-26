import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";

export type MessageParam = Anthropic.MessageParam;

export type AddAssistantOptions = Partial<
  Omit<Anthropic.MessageCreateParamsNonStreaming, "messages" | "stream">
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
