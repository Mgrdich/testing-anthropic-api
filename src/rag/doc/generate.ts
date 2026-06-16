import type { MessageParam } from "@/core/messages.ts";
import { addAssistantMessage, extractText } from "@/core/messages.ts";
import type { HandbookTopic } from "@/rag/doc/template.ts";
import { TOPICS } from "@/rag/doc/template.ts";

const DEFAULT_DOC_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM = [
  "You write engineering handbook sections in Markdown.",
  "Output ONLY the requested section's Markdown content — no preamble,",
  "no closing remarks, no explanations about what you wrote.",
  "Use varied prose, fenced code blocks (```typescript, ```sql, ```bash) where",
  "relevant, bullet lists, and tight technical voice.",
].join(" ");

function buildPrompt(topic: HandbookTopic) {
  const outline = topic.h2Outline.map((h) => `  - ${h}`).join("\n");
  return [
    `Write the "${topic.title}" section of a software engineering handbook.`,
    "",
    "Requirements:",
    `- Start with a single H1 heading: \`# ${topic.title}\``,
    "- Include these H2 subsections in order, using `## ` headings:",
    outline,
    "- Each H2 should have 2-3 paragraphs and may include H3 subsections,",
    "  bullet lists, and fenced code blocks where relevant.",
    "- Aim for ~1500 words total for the whole section.",
    "- Output only the Markdown content — no preamble, no commentary.",
  ].join("\n");
}

export type GenerateDocInput = {
  outPath: string;
  sections?: number;
  model?: string;
  onProgress?: (done: number, total: number, title: string) => void;
};

export type GenerateDocResult = {
  outPath: string;
  sectionsWritten: number;
  totalChars: number;
};

export async function generateSyntheticDoc(input: GenerateDocInput) {
  const model = input.model ?? DEFAULT_DOC_MODEL;
  const wanted = input.sections ?? TOPICS.length;
  const topics = TOPICS.slice(0, Math.min(wanted, TOPICS.length));
  const pieces: string[] = [];

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    if (!topic) continue;
    const messages: MessageParam[] = [
      { role: "user", content: buildPrompt(topic) },
    ];
    const response = await addAssistantMessage(messages, {
      model,
      system: SYSTEM,
      max_tokens: 4096,
    });
    const text = extractText(response.content);
    pieces.push(text.trim());
    const combined = pieces.join("\n\n");
    await Bun.write(input.outPath, combined);
    input.onProgress?.(i + 1, topics.length, topic.title);
  }

  const finalText = pieces.join("\n\n");
  return {
    outPath: input.outPath,
    sectionsWritten: topics.length,
    totalChars: finalText.length,
  };
}
