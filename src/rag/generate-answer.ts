import type { MessageParam } from "@/core/messages.ts";
import {
  addUserMessage,
  extractText,
  streamAssistantMessage,
} from "@/core/messages.ts";
import type { Retrieved } from "@/rag/types.ts";

const SYSTEM =
  "You answer the <question> using ONLY the chunks inside <context>. Each " +
  "chunk is wrapped in a <chunk> tag with an index attribute; cite indices " +
  "inline like [1] or [3]. If the context is insufficient to answer, say so " +
  "explicitly — do not invent facts or use outside knowledge.";

export function buildContext(retrieved: ReadonlyArray<Retrieved>) {
  return retrieved
    .map(
      (r, i) =>
        `<chunk index="${i + 1}" id="${r.chunk.id}" score="${r.score.toFixed(3)}">
${r.chunk.text}
</chunk>`,
    )
    .join("\n");
}

export async function answerWithClaude(
  retrieved: ReadonlyArray<Retrieved>,
  query: string,
  opts?: {
    model?: string;
    onText?: (delta: string) => void;
    onPrompt?: (prompt: { system: string; user: string }) => void;
  },
) {
  const userMessage = `<context>
${buildContext(retrieved)}
</context>

<question>
${query}
</question>`;
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
