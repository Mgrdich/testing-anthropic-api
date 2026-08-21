import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { z } from "zod";
import { AnthropicClient } from "@/core/client.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";

export type MessageParam = Anthropic.MessageParam;

export type AddAssistantOptions = Partial<
  Omit<Anthropic.MessageCreateParamsNonStreaming, "messages" | "stream">
>;

export type StreamAssistantOptions = Partial<
  Omit<Anthropic.MessageStreamParams, "messages">
>;

// Structured-output turn options. The `output_config`/`messages` fields are
// supplied by `parseAssistantMessage` itself; callers only tune the request.
export type ParseAssistantOptions = {
  model?: string;
  max_tokens?: number;
  system?: string;
};

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
  if (first?.type !== "text") return content;
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

/**
 * Structured-output turn. Derives a JSON-schema output format from `schema`
 * (the SDK "structured outputs" feature — `client.beta.messages.parse`
 * auto-sends the `structured-outputs` beta header) so the model is
 * constrained to emit JSON matching `schema`. No prefill/stop hacks and no
 * prose extraction: the SDK parses and Zod-validates the response for us.
 * Returns the validated value plus the raw JSON text (handy for error logs).
 * Mutates `messages` with the assistant turn, like the other primitives.
 */
export async function parseAssistantMessage<S extends z.ZodType>(
  messages: MessageParam[],
  schema: S,
  opts: ParseAssistantOptions = {},
): Promise<{ parsed: z.infer<S>; text: string }> {
  const message = await AnthropicClient.get().beta.messages.parse({
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...opts,
    messages,
    output_config: { format: betaZodOutputFormat(schema) },
  });

  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

  // `parsed_output` is null only when the response carried no text block to
  // parse; a schema-validation failure throws inside the SDK before we get
  // here. Throw before mutating history so a failed turn never dirties the
  // caller's `messages`.
  if (message.parsed_output === null) {
    throw new Error(
      `structured output returned no parsed_output; raw text:\n${text}`,
    );
  }

  // Beta response blocks and non-beta request params differ only in
  // response-only fields; the wire JSON is identical (same beta ↔ non-beta
  // boundary the tools/mcp code crosses). Keep history mutation consistent
  // with the other primitives.
  messages.push({
    role: "assistant",
    content: message.content as unknown as MessageParam["content"],
  });

  return { parsed: message.parsed_output, text };
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
