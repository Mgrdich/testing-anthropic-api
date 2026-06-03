import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

export const getTime = defineTool({
  name: "get_time",
  description: "Returns the current UTC time as an ISO 8601 string.",
  inputSchema: z.object({}),
  run: () => new Date().toISOString(),
});
