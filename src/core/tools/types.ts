import type { BetaTool } from "@anthropic-ai/sdk/resources/beta";

// Internal Tool shape — the SDK's BetaTool (the variant `betaZodTool`
// actually produces; `type: "custom"`) augmented with the local executor.
// We pick BetaTool rather than the wider BetaRunnableTool union so accessing
// `input_schema` / `name` doesn't require runtime narrowing at every call
// site. `streamAssistantMessage` casts to `Anthropic.Tool` at the wire
// boundary — the JSON shape is identical; only the TS types differ slightly
// (`required` is `string[] | readonly string[]` on beta, `string[]` on the
// non-beta wire type).
export type Tool = BetaTool & {
  run: (input: unknown) => Promise<string> | string;
  parse?: (content: unknown) => unknown;
};
