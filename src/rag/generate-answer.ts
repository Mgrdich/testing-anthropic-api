import { addUserMessage, extractText, streamAssistantMessage } from "@/core/messages.ts";
import type { MessageParam } from "@/core/messages.ts";
import type { Retrieved } from "@/rag/types.ts";

const SYSTEM =
  "You answer questions using ONLY the provided context. Cite chunk numbers " +
  "inline like [1] or [3]. If the context is insufficient to answer, say so " +
  "explicitly — do not invent facts or use outside knowledge.";

export function buildContext(retrieved: ReadonlyArray<Retrieved>): string {
  return retrieved
    .map(
      (r, i) =>
        `[${i + 1}] (id=${r.chunk.id}, score=${r.score.toFixed(3)})\n${r.chunk.text}`,
    )
    .join("\n\n---\n\n");
}

export async function answerWithClaude(
  retrieved: ReadonlyArray<Retrieved>,
  query: string,
  opts?: {
    model?: string;
    onText?: (delta: string) => void;
    onPrompt?: (prompt: { system: string; user: string }) => void;
  },
): Promise<string> {
  const userMessage = `Context:\n\n${buildContext(retrieved)}\n\n---\n\nQuestion: ${query}`;
  if (opts?.onPrompt) opts.onPrompt({ system: SYSTEM, user: userMessage });
  const messages: MessageParam[] = [];
  addUserMessage(messages, userMessage);
  const final = await streamAssistantMessage(
    messages,
    {
      ...(opts?.model ? { model: opts.model } : {}),
      system: SYSTEM,
      max_tokens: 1024,
    },
    (stream) => {
      const onText = opts?.onText;
      if (onText) stream.on("text", onText);
    },
  );
  return extractText(final.content);
}
