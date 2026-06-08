import { Embedder } from "@/rag/embedder.ts";
import type { Retriever, ScoredId } from "@/rag/types.ts";

export class VectorStore {
  private vectors: Float32Array[] = [];
  private ids: string[] = [];

  add(id: string, vec: Float32Array): void {
    this.ids.push(id);
    this.vectors.push(vec);
  }

  addBatch(items: ReadonlyArray<{ id: string; vec: Float32Array }>): void {
    for (const it of items) this.add(it.id, it.vec);
  }

  get size(): number {
    return this.ids.length;
  }

  search(queryVec: Float32Array, k: number): ScoredId[] {
    const n = this.vectors.length;
    if (n === 0 || k <= 0) return [];
    const scores: ScoredId[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const id = this.ids[i];
      const v = this.vectors[i];
      if (id === undefined || v === undefined) continue;
      scores[i] = { id, score: dot(queryVec, v) };
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, Math.min(k, n));
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) {
    s += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return s;
}

export class VectorRetriever implements Retriever {
  readonly name = "vector";
  private readonly store = new VectorStore();
  private readonly embedder: Embedder;

  constructor(embedder?: Embedder) {
    this.embedder = embedder ?? Embedder.get();
  }

  get size(): number {
    return this.store.size;
  }

  async add(id: string, text: string): Promise<void> {
    const vec = await this.embedder.embed(text);
    this.store.add(id, vec);
  }

  async addBatch(items: ReadonlyArray<{ id: string; text: string }>): Promise<void> {
    if (items.length === 0) return;
    const vecs = await this.embedder.embedBatch(items.map((it) => it.text));
    const pairs: Array<{ id: string; vec: Float32Array }> = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const vec = vecs[i];
      if (!it || !vec) continue;
      pairs.push({ id: it.id, vec });
    }
    this.store.addBatch(pairs);
  }

  async search(query: string, k: number): Promise<ScoredId[]> {
    const qVec = await this.embedder.embed(query);
    return this.store.search(qVec, k);
  }
}
