import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@/core/messages.ts";
import { extractText, streamAssistantMessage } from "@/core/messages.ts";
import type { Retrieved } from "@/rag/types.ts";

// Default path: search_result content blocks + API citations. The model's
// answer text blocks carry a structural `citations` array
// (search_result_location entries) instead of prompt-begged "[n]" indices.
const SYSTEM =
  "You answer the <question> using ONLY the provided search results. If " +
  "the search results are insufficient to answer, say so explicitly — do " +
  "not invent facts or use outside knowledge.";

// Legacy path (--no-citations): hand-rolled <chunk> XML context with the
// manual "[n]" citation instruction, kept for side-by-side comparison.
const LEGACY_SYSTEM =
  "You answer the <question> using ONLY the chunks inside <context>. Each " +
  "chunk is wrapped in a <chunk> tag with an index attribute; cite indices " +
  "inline like [1] or [3]. If the context is insufficient to answer, say so " +
  "explicitly — do not invent facts or use outside knowledge.";

/** One collected citation from a `search_result_location` entry. */
export type RagCitation = {
  citedText: string;
  source: string;
  title: string | null;
  /** 0-based index into the request's search_result blocks (= retrieval order). */
  searchResultIndex: number;
};

export type RagAnswer = {
  text: string;
  /** Empty on the legacy (--no-citations) path. */
  citations: RagCitation[];
};

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

function chunkTitle(r: Retrieved) {
  const path = r.chunk.metadata.headingPath;
  return path && path.length > 0 ? path.join(" > ") : r.chunk.id;
}

/**
 * One `search_result` block per retrieved chunk, followed by the question
 * as a plain text block. `citations: {enabled: true}` makes the model's
 * answer carry verifiable `search_result_location` citations.
 *
 * NOTE: citations are incompatible with `output_config.format` (structured
 * outputs) — combining them returns a 400. Keep this path free of
 * `output_config` if the two ever meet.
 */
export function buildSearchResultContent(
  retrieved: ReadonlyArray<Retrieved>,
  query: string,
): Anthropic.ContentBlockParam[] {
  const results: Anthropic.ContentBlockParam[] = retrieved.map((r) => ({
    type: "search_result",
    source: `doc://${r.chunk.id}`,
    title: chunkTitle(r),
    content: [{ type: "text", text: r.chunk.text }],
    citations: { enabled: true },
  }));
  return [
    ...results,
    { type: "text", text: `<question>\n${query}\n</question>` },
  ];
}

function collectCitations(content: Anthropic.Message["content"]) {
  const citations: RagCitation[] = [];
  for (const block of content) {
    if (block.type !== "text" || !block.citations) continue;
    for (const c of block.citations) {
      if (c.type !== "search_result_location") continue;
      citations.push({
        citedText: c.cited_text,
        source: c.source,
        title: c.title,
        searchResultIndex: c.search_result_index,
      });
    }
  }
  return citations;
}

export async function answerWithClaude(
  retrieved: ReadonlyArray<Retrieved>,
  query: string,
  opts?: {
    model?: string;
    /** Default true; false falls back to the legacy <chunk> XML path. */
    citations?: boolean;
    onText?: (delta: string) => void;
    onPrompt?: (prompt: { system: string; user: string }) => void;
  },
): Promise<RagAnswer> {
  const useCitations = opts?.citations !== false;
  const system = useCitations ? SYSTEM : LEGACY_SYSTEM;

  const messages: MessageParam[] = [];
  if (useCitations) {
    // Block-array user turn pushed here in the rag module — core's
    // addUserMessage stays string-only.
    const content = buildSearchResultContent(retrieved, query);
    messages.push({ role: "user", content });
    if (opts?.onPrompt) {
      opts.onPrompt({ system, user: JSON.stringify(content, null, 2) });
    }
  } else {
    const user = `<context>
${buildContext(retrieved)}
</context>

<question>
${query}
</question>`;
    messages.push({ role: "user", content: user });
    if (opts?.onPrompt) opts.onPrompt({ system, user });
  }

  // Streaming is unchanged: text deltas arrive via onText as before;
  // citations ride only on the final assembled message's text blocks.
  const final = await streamAssistantMessage(
    messages,
    {
      ...(opts?.model ? { model: opts.model } : {}),
      system,
      max_tokens: 1024,
    },
    (stream) => {
      const onText = opts?.onText;
      if (onText) stream.on("text", onText);
    },
  );
  return {
    text: extractText(final.content),
    citations: useCitations ? collectCitations(final.content) : [],
  };
}
