import type { Chunk, SizeConfig } from "@/rag/types.ts";

function findBoundary(
  text: string,
  lo: number,
  hi: number,
  splitOn: SizeConfig["splitOn"],
): number {
  if (splitOn === "char") return hi;
  const slice = text.slice(lo, hi);
  if (splitOn === "paragraph") {
    const idx = slice.lastIndexOf("\n\n");
    if (idx >= 0) return lo + idx + 2;
  }
  if (splitOn === "paragraph" || splitOn === "sentence") {
    const m = /.*[.!?](\s+)/gs.exec(slice);
    let last = -1;
    const re = /[.!?]\s+/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(slice)) !== null) {
      last = mm.index + mm[0].length;
    }
    if (m && last >= 0) return lo + last;
  }
  const wsIdx = slice.search(/\s\S*$/);
  if (wsIdx >= 0) return lo + wsIdx + 1;
  return hi;
}

export function sizeChunker(text: string, opts: SizeConfig): Chunk[] {
  const { maxChars, overlapChars, splitOn } = opts;
  const chunks: Chunk[] = [];
  const lookbackStart = Math.floor(maxChars * 0.8);
  let pos = 0;
  let n = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);
    if (end < text.length) {
      const lo = pos + lookbackStart;
      if (lo < end) {
        const snapped = findBoundary(text, lo, end, splitOn);
        if (snapped > lo && snapped <= end) end = snapped;
      }
    }
    const slice = text.slice(pos, end).trim();
    if (slice.length > 0) {
      chunks.push({
        id: `size-${String(n).padStart(4, "0")}`,
        text: slice,
        metadata: { strategy: "size", startChar: pos, endChar: end },
      });
      n++;
    }
    if (end >= text.length) break;
    const nextStart = end - overlapChars;
    pos = nextStart > pos ? nextStart : end;
  }
  return chunks;
}
