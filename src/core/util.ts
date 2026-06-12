export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
