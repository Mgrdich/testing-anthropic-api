import type { Embedder } from "@/rag/embedder.ts";
import type { Chunk, SemanticConfig } from "@/rag/types.ts";

type Sentence = { text: string; start: number; end: number };

function splitSentences(text: string): Sentence[] {
  const re = /[^.!?]+(?:[.!?]+|$)/g;
  const out: Sentence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw.trim().length === 0) continue;
    out.push({ text: raw.trim(), start: m.index, end: m.index + raw.length });
  }
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

function buildSegments(
  sentences: Sentence[],
  breakAfter: Set<number>,
): Sentence[][] {
  const segments: Sentence[][] = [];
  let cur: Sentence[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (!s) continue;
    cur.push(s);
    if (breakAfter.has(i) || i === sentences.length - 1) {
      if (cur.length > 0) segments.push(cur);
      cur = [];
    }
  }
  return segments;
}

function segmentText(seg: Sentence[]): { text: string; start: number; end: number } {
  const first = seg[0];
  const last = seg[seg.length - 1];
  if (!first || !last) return { text: "", start: 0, end: 0 };
  return {
    text: seg.map((s) => s.text).join(" "),
    start: first.start,
    end: last.end,
  };
}

function mergeAndSplit(
  segments: Sentence[][],
  minChars: number,
  maxChars: number,
): Sentence[][] {
  const merged: Sentence[][] = [];
  let buf: Sentence[] = [];
  let bufLen = 0;
  for (const seg of segments) {
    const segLen = segmentText(seg).text.length;
    if (bufLen + segLen <= maxChars) {
      buf.push(...seg);
      bufLen += segLen;
      if (bufLen >= minChars) {
        merged.push(buf);
        buf = [];
        bufLen = 0;
      }
    } else {
      if (buf.length > 0) {
        merged.push(buf);
        buf = [];
        bufLen = 0;
      }
      if (segLen <= maxChars) {
        buf = [...seg];
        bufLen = segLen;
      } else {
        let chunk: Sentence[] = [];
        let chunkLen = 0;
        for (const s of seg) {
          if (chunkLen + s.text.length > maxChars && chunk.length > 0) {
            merged.push(chunk);
            chunk = [];
            chunkLen = 0;
          }
          chunk.push(s);
          chunkLen += s.text.length + 1;
        }
        if (chunk.length > 0) {
          buf = chunk;
          bufLen = chunkLen;
        }
      }
    }
  }
  if (buf.length > 0) merged.push(buf);
  return merged;
}

export async function semanticChunker(
  text: string,
  opts: SemanticConfig,
  embedder: Embedder,
): Promise<Chunk[]> {
  const sentences = splitSentences(text);
  if (sentences.length < 3) {
    const first = sentences[0];
    const last = sentences[sentences.length - 1];
    if (!first || !last) return [];
    return [
      {
        id: "sem-0000",
        text: text.trim(),
        metadata: {
          strategy: "semantic",
          startChar: first.start,
          endChar: last.end,
        },
      },
    ];
  }

  const window = opts.sentenceWindow;
  const groupTexts: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(sentences.length - 1, i + window);
    const parts: string[] = [];
    for (let j = lo; j <= hi; j++) {
      const s = sentences[j];
      if (s) parts.push(s.text);
    }
    groupTexts.push(parts.join(" "));
  }

  const embeds = await embedder.embedBatch(groupTexts);
  const dists: number[] = [];
  for (let i = 0; i < embeds.length - 1; i++) {
    const a = embeds[i];
    const b = embeds[i + 1];
    if (!a || !b) continue;
    dists.push(1 - dot(a, b));
  }
  const threshold = percentile(dists, opts.breakpointPercentile);
  const breakAfter = new Set<number>();
  for (let i = 0; i < dists.length; i++) {
    const d = dists[i] ?? 0;
    if (d >= threshold) breakAfter.add(i);
  }

  const segments = buildSegments(sentences, breakAfter);
  const merged = mergeAndSplit(segments, opts.minChunkChars, opts.maxChunkChars);

  const chunks: Chunk[] = [];
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];
    if (!seg || seg.length === 0) continue;
    const { text: segText, start, end } = segmentText(seg);
    chunks.push({
      id: `sem-${String(i).padStart(4, "0")}`,
      text: segText,
      metadata: {
        strategy: "semantic",
        startChar: start,
        endChar: end,
      },
    });
  }
  return chunks;
}
