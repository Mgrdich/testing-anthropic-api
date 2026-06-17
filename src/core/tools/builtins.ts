import { calculator } from "@/core/tools/calculator.ts";
import { echo } from "@/core/tools/echo.ts";
import { getTime } from "@/core/tools/get_time.ts";
import { getWeather } from "@/core/tools/get_weather.ts";
import type { Tool } from "@/core/tools/types.ts";

// `satisfies` (not `: Record<string, Tool>`) so the literal keys survive in
// the type — `BuiltinToolName` is derived from them, and the CLI parser
// validates `--tools` names against this set.
export const BUILTIN_TOOLS = {
  echo,
  get_time: getTime,
  calculator,
  get_weather: getWeather,
} satisfies Record<string, Tool>;

/** The name of a built-in tool — the keys of `BUILTIN_TOOLS`. */
export type BuiltinToolName = keyof typeof BUILTIN_TOOLS;

/** Runtime narrow of an arbitrary string to a built-in tool name. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return name in BUILTIN_TOOLS;
}

// Names of tools that have side effects. `runAgenticTurn` (via the
// `isMutating` hook) gates these behind `approveMutating` — the REPL prompts
// y/N before each call; the one-shot/piped path throws because no TTY is
// available. Add a tool's name here when introducing bash, write_file, etc.
export const MUTATING_TOOLS: ReadonlySet<string> = new Set<string>([]);

// Names are validated at the CLI boundary (see `cli/args.ts`), so this just
// maps the already-valid selection to tools.
export function selectTools(filter: "all" | readonly BuiltinToolName[]) {
  if (filter === "all") return Object.values(BUILTIN_TOOLS);
  return filter.map((name) => BUILTIN_TOOLS[name]);
}
