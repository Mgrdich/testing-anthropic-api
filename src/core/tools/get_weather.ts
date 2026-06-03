import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

export const getWeather = defineTool({
  name: "get_weather",
  description:
    "Returns mocked weather data for a given city. For demo purposes only — no real network call is made.",
  inputSchema: z.object({
    city: z.string().describe("City name"),
  }),
  run: ({ city }) =>
    JSON.stringify({
      city,
      tempC: 22,
      condition: "sunny",
      note: "mocked data",
    }),
});
