import { chunk } from "@/rag/chunkers/index.ts";
import { Embedder } from "@/rag/embedder.ts";
import { BM25Retriever } from "@/rag/bm25.ts";
import { VectorRetriever } from "@/rag/vector-store.ts";
import { retrieveHybrid } from "@/rag/hybrid.ts";
import { answerWithClaude } from "@/rag/generate-answer.ts";
import type {
  Chunk,
  ChunkerConfig,
  RetrievalMode,
  Retrieved,
  Retriever,
} from "@/rag/types.ts";

export type RunRagInput = {
  docPath: string;
  query: string;
  chunkerConfig: ChunkerConfig;
  k?: number;
  retrieval?: RetrievalMode;
  generate?: boolean;
  answerModel?: string;
  onText?: (delta: string) => void;
};

export type RunRagOutput = {
  chunks: Chunk[];
  retrieved: Retrieved[];
  answer?: string;
  timings: {
    chunk: number;
    index: number;
    retrieve: number;
    generate?: number;
  };
};

export async function runRag(input: RunRagInput): Promise<RunRagOutput> {
  const k = input.k ?? 5;
  const mode: RetrievalMode = input.retrieval ?? "hybrid";
  const shouldGenerate = input.generate ?? true;

  const docText = await Bun.file(input.docPath).text();
  if (!docText.trim()) {
    throw new Error(`document at ${input.docPath} is empty`);
  }

  const embedder = Embedder.get();
  const needsEmbedder =
    input.chunkerConfig.strategy === "semantic" || mode !== "bm25";
  if (needsEmbedder) await embedder.ensureReady();

  const tChunkStart = performance.now();
  const chunks = await chunk(docText, input.chunkerConfig, embedder);
  const tChunk = performance.now() - tChunkStart;

  const retrievers: Retriever[] = [];
  if (mode === "vector" || mode === "hybrid") {
    retrievers.push(new VectorRetriever(embedder));
  }
  if (mode === "bm25" || mode === "hybrid") {
    retrievers.push(new BM25Retriever());
  }

  const items = chunks.map((c) => ({ id: c.id, text: c.text }));
  const tIndexStart = performance.now();
  await Promise.all(retrievers.map((r) => r.addBatch(items)));
  const tIndex = performance.now() - tIndexStart;

  const tRetrieveStart = performance.now();
  let ranking: Array<{ id: string; score: number }>;
  if (mode === "hybrid") {
    const fused = await retrieveHybrid(retrievers, input.query, k);
    ranking = fused.map((r) => ({ id: r.id, score: r.rrfScore }));
  } else {
    const sole = retrievers[0];
    if (!sole) throw new Error("no retriever configured");
    ranking = await sole.search(input.query, k);
  }
  const tRetrieve = performance.now() - tRetrieveStart;

  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const retrieved: Retrieved[] = [];
  for (let i = 0; i < ranking.length; i++) {
    const r = ranking[i];
    if (!r) continue;
    const c = chunkById.get(r.id);
    if (!c) continue;
    retrieved.push({ chunk: c, score: r.score, rank: i + 1 });
  }

  let answer: string | undefined;
  let tGenerate: number | undefined;
  if (shouldGenerate && retrieved.length > 0) {
    const tGenStart = performance.now();
    answer = await answerWithClaude(retrieved, input.query, {
      ...(input.answerModel ? { model: input.answerModel } : {}),
      ...(input.onText ? { onText: input.onText } : {}),
    });
    tGenerate = performance.now() - tGenStart;
  }

  return {
    chunks,
    retrieved,
    ...(answer !== undefined ? { answer } : {}),
    timings: {
      chunk: tChunk,
      index: tIndex,
      retrieve: tRetrieve,
      ...(tGenerate !== undefined ? { generate: tGenerate } : {}),
    },
  };
}
