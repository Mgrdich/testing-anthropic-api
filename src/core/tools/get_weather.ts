import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

/** Raw Zod shape shared with the Agent SDK's `tool()` — see `echo.ts`. */
export const getWeatherShape = {
  city: z.string().describe("City name"),
};

export const getWeather = defineTool({
  name: "get_weather",
  description:
    "Returns mocked weather data for a given city. For demo purposes only — no real network call is made.",
  inputSchema: z.object(getWeatherShape),
  run: ({ city }) =>
    JSON.stringify({
      city,
      tempC: 22,
      condition: "sunny",
      note: "mocked data",
    }),
});
