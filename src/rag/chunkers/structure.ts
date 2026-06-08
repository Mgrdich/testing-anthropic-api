import { sizeChunker } from "@/rag/chunkers/size.ts";
import type { Chunk, StructureConfig } from "@/rag/types.ts";

type Section = {
  headingPath: string[];
  text: string;
  startChar: number;
  endChar: number;
};

function parseSections(text: string, maxLevel: number): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  const path: string[] = [];
  let buf: string[] = [];
  let bufStart = 0;
  let offset = 0;
  let inFence = false;

  const flush = (endOffset: number): void => {
    const body = buf.join("\n").trim();
    if (body.length > 0) {
      sections.push({
        headingPath: [...path],
        text: body,
        startChar: bufStart,
        endChar: endOffset,
      });
    }
    buf = [];
  };

  for (const line of lines) {
    const lineLen = line.length + 1;
    const fenceMatch = /^\s*```/.test(line);
    if (fenceMatch) {
      inFence = !inFence;
      buf.push(line);
      offset += lineLen;
      continue;
    }
    if (!inFence) {
      const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (h && h[1] && h[2]) {
        const level = h[1].length;
        const title = h[2];
        if (level <= maxLevel) {
          flush(offset);
          path.length = level - 1;
          path.push(title);
          bufStart = offset + lineLen;
          offset += lineLen;
          continue;
        }
      }
    }
    if (buf.length === 0) bufStart = offset;
    buf.push(line);
    offset += lineLen;
  }
  flush(offset);
  return sections;
}

function splitLargeSection(section: Section, maxChars: number): Section[] {
  if (section.text.length <= maxChars) return [section];
  const parts = section.text.split(/\n\n+/);
  const out: Section[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let inFence = false;
  let runningStart = section.startChar;

  const flush = (): void => {
    if (cur.length === 0) return;
    const body = cur.join("\n\n").trim();
    if (body.length > 0) {
      out.push({
        headingPath: section.headingPath,
        text: body,
        startChar: runningStart,
        endChar: runningStart + body.length,
      });
    }
    runningStart += body.length + 2;
    cur = [];
    curLen = 0;
  };

  for (const para of parts) {
    const fenceCount = (para.match(/```/g) ?? []).length;
    const wouldEnterFence = inFence;
    if (!wouldEnterFence && curLen + para.length > maxChars && cur.length > 0) {
      flush();
    }
    cur.push(para);
    curLen += para.length + 2;
    if (fenceCount % 2 === 1) inFence = !inFence;
  }
  flush();
  return out;
}

export function structureChunker(text: string, opts: StructureConfig): Chunk[] {
  const sections = parseSections(text, opts.maxLevel);
  const hasHeadings = sections.some((s) => s.headingPath.length > 0);
  if (!hasHeadings) {
    process.stderr.write(
      "[structure] no headings detected — falling back to size chunker\n",
    );
    return sizeChunker(text, {
      strategy: "size",
      maxChars: opts.maxChars,
      overlapChars: 150,
      splitOn: "paragraph",
    });
  }

  let split: Section[] = [];
  for (const sec of sections) split.push(...splitLargeSection(sec, opts.maxChars));

  if (opts.joinShortSiblings) {
    const merged: Section[] = [];
    let pending: Section | null = null;
    for (const s of split) {
      if (pending) {
        merged.push({
          headingPath: s.headingPath,
          text: `${pending.text}\n\n${s.text}`,
          startChar: pending.startChar,
          endChar: s.endChar,
        });
        pending = null;
        continue;
      }
      if (s.text.length < 200) {
        pending = s;
      } else {
        merged.push(s);
      }
    }
    if (pending) merged.push(pending);
    split = merged;
  }

  const chunks: Chunk[] = [];
  for (let i = 0; i < split.length; i++) {
    const s = split[i];
    if (!s) continue;
    const pathSlug = s.headingPath
      .map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20))
      .join(".") || "root";
    chunks.push({
      id: `struct-${pathSlug}-${i}`,
      text: s.text,
      metadata: {
        strategy: "structure",
        startChar: s.startChar,
        endChar: s.endChar,
        headingPath: s.headingPath,
      },
    });
  }
  return chunks;
}
