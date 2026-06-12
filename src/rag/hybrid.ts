import type { Retriever, RrfScoredId, ScoredId } from "@/rag/types.ts";

export function rrf(
  rankings: ReadonlyArray<ReadonlyArray<ScoredId>>,
  k: number = 60,
) {
  const acc = new Map<string, number>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const item = ranking[rank];
      if (!item) continue;
      const contribution = 1 / (k + rank + 1);
      acc.set(item.id, (acc.get(item.id) ?? 0) + contribution);
    }
  }
  const out: RrfScoredId[] = [];
  for (const [id, rrfScore] of acc) out.push({ id, rrfScore });
  out.sort((a, b) => b.rrfScore - a.rrfScore);
  return out;
}

export type HybridRanking = {
  name: string;
  ranking: ReadonlyArray<ScoredId>;
};

/**
 * Generic hybrid retrieval: query every retriever, oversample by 3x, RRF-fuse,
 * slice to k. Works with any combination of vector / BM25 / future retrievers.
 *
 * `opts.onRankings` fires after every retriever has returned its top-`k*3`
 * ranking but before RRF fuses them — useful for debug tracing.
 */
export async function retrieveHybrid(
  retrievers: ReadonlyArray<Retriever>,
  query: string,
  k: number,
  rrfK: number = 60,
  opts?: { onRankings?: (per: ReadonlyArray<HybridRanking>) => void },
) {
  if (retrievers.length === 0) return [];
  const over = Math.max(k * 3, k);
  const rankings = await Promise.all(retrievers.map((r) => r.search(query, over)));
  if (opts?.onRankings) {
    opts.onRankings(
      retrievers.map((r, i) => ({ name: r.name, ranking: rankings[i] ?? [] })),
    );
  }
  return rrf(rankings, rrfK).slice(0, k);
}
