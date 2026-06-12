import { calculator } from "@/core/tools/calculator.ts";
import { echo } from "@/core/tools/echo.ts";
import { getTime } from "@/core/tools/get_time.ts";
import { getWeather } from "@/core/tools/get_weather.ts";
import type { Tool } from "@/core/tools/types.ts";

export const BUILTIN_TOOLS: Record<string, Tool> = {
  echo,
  get_time: getTime,
  calculator,
  get_weather: getWeather,
};

// Names of tools that have side effects. `runAgenticTurn` (via the
// `isMutating` hook) gates these behind `approveMutating` — the REPL prompts
// y/N before each call; the one-shot/piped path throws because no TTY is
// available. Add a tool's name here when introducing bash, write_file, etc.
export const MUTATING_TOOLS: ReadonlySet<string> = new Set<string>([]);

export function selectTools(filter: "all" | readonly string[]) {
  if (filter === "all") return Object.values(BUILTIN_TOOLS);
  return filter.map((name) => {
    const tool = BUILTIN_TOOLS[name];
    if (!tool) {
      const known = Object.keys(BUILTIN_TOOLS).join(", ");
      throw new Error(`unknown tool: ${name} (known: ${known})`);
    }
    return tool;
  });
}
