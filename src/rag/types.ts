import { z } from "zod";

export const ChunkSchema = z.object({
  id: z.string(),
  text: z.string(),
  metadata: z.object({
    strategy: z.enum(["size", "structure", "semantic"]),
    startChar: z.number().int().nonnegative(),
    endChar: z.number().int().nonnegative(),
    headingPath: z.array(z.string()).optional(),
  }),
});
export type Chunk = z.infer<typeof ChunkSchema>;

export const SizeConfigSchema = z.object({
  strategy: z.literal("size"),
  maxChars: z.number().int().positive().default(1000),
  overlapChars: z.number().int().nonnegative().default(150),
  splitOn: z.enum(["paragraph", "sentence", "char"]).default("paragraph"),
});
export type SizeConfig = z.infer<typeof SizeConfigSchema>;

export const StructureConfigSchema = z.object({
  strategy: z.literal("structure"),
  maxLevel: z.number().int().min(1).max(3).default(3),
  maxChars: z.number().int().positive().default(2000),
  joinShortSiblings: z.boolean().default(true),
});
export type StructureConfig = z.infer<typeof StructureConfigSchema>;

export const SemanticConfigSchema = z.object({
  strategy: z.literal("semantic"),
  sentenceWindow: z.number().int().min(0).default(1),
  breakpointPercentile: z.number().min(0).max(100).default(95),
  minChunkChars: z.number().int().positive().default(200),
  maxChunkChars: z.number().int().positive().default(2000),
});
export type SemanticConfig = z.infer<typeof SemanticConfigSchema>;

export const ChunkerConfigSchema = z.discriminatedUnion("strategy", [
  SizeConfigSchema,
  StructureConfigSchema,
  SemanticConfigSchema,
]);
export type ChunkerConfig = z.infer<typeof ChunkerConfigSchema>;

export type ScoredId = { id: string; score: number };
export type RrfScoredId = { id: string; rrfScore: number };

export type Retrieved = {
  chunk: Chunk;
  score: number;
  rank: number;
};

export type RetrievalMode = "vector" | "bm25" | "hybrid";

/**
 * Uniform retrieval surface. Vector, BM25, and any future retriever
 * (TF-IDF, reranker, cross-encoder…) implement the same API so the
 * orchestrator and hybrid fusion stay backend-agnostic.
 */
export interface Retriever {
  readonly name: string;
  readonly size: number;
  add(id: string, text: string): Promise<void>;
  addBatch(items: ReadonlyArray<{ id: string; text: string }>): Promise<void>;
  search(query: string, k: number): Promise<ScoredId[]>;
}
