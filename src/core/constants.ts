export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * Model used to answer MCP `sampling/createMessage` requests (see
 * `mcp/client/sampling.ts`). Those are summarization-style tasks where a
 * small, fast model is plenty — Haiku keeps the round-trip cheap.
 */
export const SAMPLING_MODEL = "claude-haiku-4-5-20251001";

/**
 * Default model for the server-side advisor tool (see `core/advisor.ts`).
 * The advisor is a *stronger* model the executor (`DEFAULT_MODEL`) can
 * consult mid-turn, so this is deliberately a bigger model than the default.
 */
export const ADVISOR_MODEL = "claude-opus-4-8";
