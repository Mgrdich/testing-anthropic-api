import type { Retriever, ScoredId } from "@/rag/types.ts";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "he", "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were",
  "will", "with", "i", "you", "we", "this", "but", "or", "not", "they", "their",
  "there", "which", "what", "when", "how", "do", "does", "did", "if", "so",
  "than", "then", "these", "those",
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

type DocEntry = {
  id: string;
  tf: Map<string, number>;
  len: number;
};

export class BM25Index {
  private docs: DocEntry[] = [];
  private df = new Map<string, number>();
  private postings = new Map<string, Set<number>>();
  private avgDocLen = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(opts?: { k1?: number; b?: number }) {
    this.k1 = opts?.k1 ?? 1.5;
    this.b = opts?.b ?? 0.75;
  }

  get size(): number {
    return this.docs.length;
  }

  add(id: string, text: string): void {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const docIdx = this.docs.length;
    this.docs.push({ id, tf, len: tokens.length });
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
      let set = this.postings.get(term);
      if (!set) {
        set = new Set<number>();
        this.postings.set(term, set);
      }
      set.add(docIdx);
    }
    const total = this.docs.reduce((acc, d) => acc + d.len, 0);
    this.avgDocLen = total / this.docs.length;
  }

  search(query: string, k: number): ScoredId[] {
    if (this.docs.length === 0 || k <= 0) return [];
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];
    const N = this.docs.length;
    const candidates = new Set<number>();
    for (const t of qTerms) {
      const posting = this.postings.get(t);
      if (!posting) continue;
      for (const idx of posting) candidates.add(idx);
    }
    if (candidates.size === 0) return [];
    const scores: ScoredId[] = [];
    for (const idx of candidates) {
      const doc = this.docs[idx];
      if (!doc) continue;
      let s = 0;
      for (const term of qTerms) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const denom = tf + this.k1 * (1 - this.b + (this.b * doc.len) / this.avgDocLen);
        s += idf * (tf * (this.k1 + 1)) / denom;
      }
      if (s > 0) scores.push({ id: doc.id, score: s });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, Math.min(k, scores.length));
  }
}

export class BM25Retriever implements Retriever {
  readonly name = "bm25";
  private readonly index: BM25Index;

  constructor(opts?: { k1?: number; b?: number }) {
    this.index = new BM25Index(opts);
  }

  get size(): number {
    return this.index.size;
  }

  async add(id: string, text: string): Promise<void> {
    this.index.add(id, text);
  }

  async addBatch(items: ReadonlyArray<{ id: string; text: string }>): Promise<void> {
    for (const it of items) this.index.add(it.id, it.text);
  }

  async search(query: string, k: number): Promise<ScoredId[]> {
    return this.index.search(query, k);
  }
}
