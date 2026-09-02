import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

/** Raw Zod shape shared with the Agent SDK's `tool()` — see `echo.ts`. */
export const getTimeShape = {};

export const getTime = defineTool({
  name: "get_time",
  description: "Returns the current UTC time as an ISO 8601 string.",
  inputSchema: z.object(getTimeShape),
  run: () => new Date().toISOString(),
});
