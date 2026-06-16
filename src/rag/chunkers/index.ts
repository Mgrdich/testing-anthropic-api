import { semanticChunker } from "@/rag/chunkers/semantic.ts";
import { sizeChunker } from "@/rag/chunkers/size.ts";
import { structureChunker } from "@/rag/chunkers/structure.ts";
import type { Embedder } from "@/rag/embedder.ts";
import type { ChunkerConfig } from "@/rag/types.ts";

export { semanticChunker } from "@/rag/chunkers/semantic.ts";
export { sizeChunker } from "@/rag/chunkers/size.ts";
export { structureChunker } from "@/rag/chunkers/structure.ts";

export async function chunk(
  text: string,
  config: ChunkerConfig,
  embedder?: Embedder,
) {
  switch (config.strategy) {
    case "size":
      return sizeChunker(text, config);
    case "structure":
      return structureChunker(text, config);
    case "semantic": {
      if (!embedder) {
        throw new Error("semantic chunker requires an embedder");
      }
      return semanticChunker(text, config, embedder);
    }
  }
}
