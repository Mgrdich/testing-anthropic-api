/**
 * Float32Array math used by the embedder, vector store, and semantic
 * chunker. Kept in one place so the inner loops stay consistent.
 */

export function dot(a: Float32Array, b: Float32Array) {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function l2Normalize(vec: Float32Array) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i] ?? 0) / norm;
  }
  return out;
}
