import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

export const echo = defineTool({
  name: "echo",
  description: "Returns the given text verbatim. Useful for testing the tool-use loop.",
  inputSchema: z.object({
    text: z.string().describe("Text to echo back"),
  }),
  run: ({ text }) => text,
});
