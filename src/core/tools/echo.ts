import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

/**
 * The raw Zod shape, hoisted out of `z.object(...)` so both tool surfaces can
 * share one declaration: `defineTool` (this file) wants a `ZodType`, while the
 * Agent SDK's `tool()` wants the raw shape. `z.object(shape)` produces the same
 * JSON Schema either way, so nothing on the wire changes.
 */
export const echoShape = {
  text: z.string().describe("Text to echo back"),
};

export const echo = defineTool({
  name: "echo",
  description:
    "Returns the given text verbatim. Useful for testing the tool-use loop.",
  inputSchema: z.object(echoShape),
  run: ({ text }) => text,
});
