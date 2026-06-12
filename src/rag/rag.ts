import { Debug } from "@/core/index.ts";
import { chunk } from "@/rag/chunkers/index.ts";
import { Embedder } from "@/rag/embedder.ts";
import { BM25Retriever, tokenize } from "@/rag/bm25.ts";
import { VectorRetriever } from "@/rag/vector-store.ts";
import { retrieveHybrid } from "@/rag/hybrid.ts";
import { answerWithClaude } from "@/rag/generate-answer.ts";
import type {
  Chunk,
  ChunkerConfig,
  RetrievalMode,
  Retrieved,
  Retriever,
  ScoredId,
} from "@/rag/types.ts";

const dbg = Debug.get();

function formatRanking(ranking: ReadonlyArray<ScoredId>) {
  return ranking
    .map((r, i) => `  ${i + 1}. ${r.id} score=${r.score.toFixed(4)}`)
    .join("\n");
}

export type RetrievalTimings = {
  chunk: number;
  index: number;
  retrieve: number;
};

export type RunRagInput = {
  docPath: string;
  query: string;
  chunkerConfig: ChunkerConfig;
  k?: number;
  retrieval?: RetrievalMode;
  generate?: boolean;
  answerModel?: string;
  onText?: (delta: string) => void;
  /**
   * Fires after retrieval, before generation. Lets the CLI print chunk
   * previews + section headers before the streaming answer starts, so
   * the terminal output stays in a sensible order.
   */
  onRetrieved?: (
    retrieved: Retrieved[],
    timings: RetrievalTimings,
    chunks: Chunk[],
  ) => Promise<void> | void;
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

export async function runRag(input: RunRagInput) {
  const k = input.k ?? 5;
  const mode: RetrievalMode = input.retrieval ?? "hybrid";
  const shouldGenerate = input.generate ?? true;

  dbg.log(
    `runRag: doc=${input.docPath} chunker=${input.chunkerConfig.strategy} ` +
      `retrieval=${mode} k=${k} generate=${shouldGenerate}`,
  );
  dbg.log(() => `chunker config: ${JSON.stringify(input.chunkerConfig)}`);

  const docText = await Bun.file(input.docPath).text();
  if (!docText.trim()) {
    throw new Error(`document at ${input.docPath} is empty`);
  }
  dbg.log(`loaded doc: ${docText.length} chars`);

  const embedder = Embedder.get();
  const needsEmbedder =
    input.chunkerConfig.strategy === "semantic" || mode !== "bm25";
  if (needsEmbedder) await embedder.ensureReady();

  const tChunkStart = performance.now();
  const chunks = await chunk(docText, input.chunkerConfig, embedder);
  const tChunk = performance.now() - tChunkStart;
  dbg.block(`chunks (${chunks.length})`, () =>
    chunks
      .map((c) => {
        const path = c.metadata.headingPath?.join(" > ") ?? "";
        return `  ${c.id} len=${c.text.length}${path ? ` path="${path}"` : ""}`;
      })
      .join("\n"),
  );

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
  dbg.log(
    () => `indexed: ${retrievers.map((r) => `${r.name}(${r.size})`).join(", ")}`,
  );
  dbg.log(() => `query: ${JSON.stringify(input.query)}`);
  if (mode !== "vector") {
    dbg.log(() => {
      const tokens = tokenize(input.query);
      return (
        `bm25 query tokens (after stopwords, n=${tokens.length}): ` +
        (tokens.length > 0 ? tokens.join(", ") : "<empty>")
      );
    });
  }

  const tRetrieveStart = performance.now();
  let ranking: Array<{ id: string; score: number }>;
  if (mode === "hybrid") {
    const fused = await retrieveHybrid(retrievers, input.query, k, 60, {
      onRankings: (per) => {
        for (const p of per) {
          dbg.block(
            `${p.name} ranking (top ${p.ranking.length}, pre-RRF)`,
            () => formatRanking(p.ranking),
          );
        }
      },
    });
    ranking = fused.map((r) => ({ id: r.id, score: r.rrfScore }));
    dbg.block(`fused RRF top-${ranking.length}`, () => formatRanking(ranking));
  } else {
    const sole = retrievers[0];
    if (!sole) throw new Error("no retriever configured");
    ranking = await sole.search(input.query, k);
    dbg.block(`${sole.name} ranking (top ${ranking.length})`, () =>
      formatRanking(ranking),
    );
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

  if (input.onRetrieved) {
    await input.onRetrieved(
      retrieved,
      { chunk: tChunk, index: tIndex, retrieve: tRetrieve },
      chunks,
    );
  }

  let answer: string | undefined;
  let tGenerate: number | undefined;
  if (shouldGenerate && retrieved.length > 0) {
    const tGenStart = performance.now();
    answer = await answerWithClaude(retrieved, input.query, {
      ...(input.answerModel ? { model: input.answerModel } : {}),
      ...(input.onText ? { onText: input.onText } : {}),
      onPrompt: ({ system, user }) => {
        dbg.block("system prompt", system);
        dbg.block("user message", user);
      },
    });
    tGenerate = performance.now() - tGenStart;
  } else if (shouldGenerate) {
    dbg.log("skipping generation: 0 chunks retrieved");
  } else {
    dbg.log("skipping generation: --no-generate");
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
