import type { BetaTool } from "@anthropic-ai/sdk/resources/beta";

/**
 * The local executor half of a tool, shared by both tool flavors below.
 * `parse` validates the model's raw input before `run` sees it (the split
 * `betaZodTool` produces); tools without a schema omit it or pass identity.
 */
export type ToolExecutor = {
  run: (input: unknown) => Promise<string> | string;
  parse?: (content: unknown) => unknown;
};

/**
 * A **custom** tool: we supply the JSON schema, so the wire form carries
 * `input_schema`. This is the SDK's `BetaTool` (the variant `betaZodTool`
 * actually produces; `type: "custom"`) augmented with the local executor.
 * We pick `BetaTool` rather than the wider `BetaRunnableTool` union so
 * accessing `input_schema` / `name` doesn't require runtime narrowing at
 * every call site. `streamAssistantMessage` casts to `Anthropic.Tool` at the
 * wire boundary — the JSON shape is identical; only the TS types differ
 * slightly (`required` is `string[] | readonly string[]` on beta, `string[]`
 * on the non-beta wire type).
 */
export type CustomTool = BetaTool & ToolExecutor;

/**
 * An **Anthropic-defined** tool (memory, code execution, text editor, …):
 * the schema is built into the model, so the wire form is just
 * `{ type, name }` and there is no `input_schema` to send. The local
 * executor still runs client-side. `input_schema?: never` makes the union
 * below discriminable by that field alone, which is what
 * `isAnthropicDefinedTool` narrows on.
 */
export type AnthropicDefinedTool = ToolExecutor & {
  /** Versioned wire type, e.g. `"memory_20250818"`. */
  type: string;
  name: string;
  input_schema?: never;
};

/**
 * Internal Tool shape. Both runners accept the union; the difference is
 * only how each is projected onto the request's `tools` array (schema vs.
 * `{type, name}` passthrough — see `agentic.ts`).
 */
export type Tool = CustomTool | AnthropicDefinedTool;

/**
 * Narrow a tool to the Anthropic-defined variant. Keyed on the absence of
 * `input_schema` rather than on `type`, so any future server-shaped tool
 * (code execution for programmatic tool calling, text editor, …) passes
 * through without touching this predicate.
 */
export function isAnthropicDefinedTool(
  tool: Tool,
): tool is AnthropicDefinedTool {
  return !("input_schema" in tool) || tool.input_schema === undefined;
}
