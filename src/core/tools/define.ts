import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { CustomTool } from "@/core/tools/types.ts";

type BetaZodToolParams<S extends z.ZodType> = Parameters<
  typeof betaZodTool<S>
>[0];

// Re-export of Anthropic's official `betaZodTool` (Zod schema → JSON schema
// + typed `run` input) with the return type narrowed to our internal Tool.
// All the real work lives in the SDK; this wrapper just isolates one cast
// and turns on strict tool use.
//
// `strict: true` (no beta header) makes the API guarantee that
// `tool_use.input` validates against the schema exactly. It has to be set on
// the returned object rather than passed through `betaZodTool`, whose
// options type has no `strict` field — the underlying `BetaTool` shape it
// produces does. The API requires the schema to carry
// `additionalProperties: false` alongside `required`; Zod v4's JSON-schema
// conversion already emits it for `z.object(...)`, and the normalize step
// below is the belt-and-braces guard so a schema shape that doesn't can
// never ship a strict tool the API would 400 on.
export function defineTool<S extends z.ZodType>(spec: BetaZodToolParams<S>) {
  const tool = betaZodTool(spec) as unknown as CustomTool;
  const input_schema = withClosedProperties(tool.input_schema);
  return {
    ...tool,
    // Strict requires *both* halves of the contract. `additionalProperties`
    // is normalized above; `required` can't be — a schema with optional
    // fields legitimately omits them, and marking that strict 400s at the
    // first call. Fail here instead, where the tool is defined.
    ...(isStrictable(input_schema) ? { strict: true } : {}),
    input_schema,
  } satisfies CustomTool;
}

function withClosedProperties(schema: CustomTool["input_schema"]) {
  if (schema.type !== "object" || schema.additionalProperties === false) {
    return schema;
  }
  return { ...schema, additionalProperties: false };
}

/**
 * Strict tool use requires a closed object schema whose properties are all
 * required. A schema that doesn't qualify ships non-strict rather than
 * shipping a request the API rejects.
 */
function isStrictable(schema: CustomTool["input_schema"]) {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    return false;
  }
  const properties = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return properties.every((name) => required.has(name));
}
