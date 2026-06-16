import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Tool } from "@/core/tools/types.ts";

type BetaZodToolParams<S extends z.ZodType> = Parameters<
  typeof betaZodTool<S>
>[0];

// Re-export of Anthropic's official `betaZodTool` (Zod schema → JSON schema
// + typed `run` input) with the return type narrowed to our internal Tool.
// All the real work lives in the SDK; this wrapper just isolates one cast.
export function defineTool<S extends z.ZodType>(spec: BetaZodToolParams<S>) {
  return betaZodTool(spec) as unknown as Tool;
}
