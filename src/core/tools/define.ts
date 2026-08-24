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
  return {
    ...tool,
    strict: true,
    input_schema: withClosedProperties(tool.input_schema),
  } satisfies CustomTool;
}

function withClosedProperties(schema: CustomTool["input_schema"]) {
  if (schema.type !== "object" || schema.additionalProperties === false) {
    return schema;
  }
  return { ...schema, additionalProperties: false };
}
