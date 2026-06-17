export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * Model used to answer MCP `sampling/createMessage` requests (see
 * `mcp/client/sampling.ts`). Those are summarization-style tasks where a
 * small, fast model is plenty — Haiku keeps the round-trip cheap.
 */
export const SAMPLING_MODEL = "claude-haiku-4-5-20251001";
