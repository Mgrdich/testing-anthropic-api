/**
 * Extract a balanced JSON span (object or array) from a model response that
 * may have surrounding prose, fence markers, or other noise. Finds the first
 * `open` bracket and the last `close` bracket and parses everything between
 * them. Caller validates the parsed value (typically via Zod).
 */
export function extractJsonSpan(
  text: string,
  open: "[" | "{",
  close: "]" | "}",
  errorLabel: string,
): unknown {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${errorLabel} (no '${open}' or '${close}' found):\n${text}`,
    );
  }
  return JSON.parse(text.slice(start, end + 1));
}
