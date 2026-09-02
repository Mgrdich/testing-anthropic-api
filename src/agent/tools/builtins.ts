import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { memoryTool } from "@/agent/tools/memory.ts";
import {
  BUILTIN_TOOLS,
  type BuiltinToolName,
  MUTATING_TOOLS,
  selectTools,
} from "@/core/index.ts";
import { calculatorShape } from "@/core/tools/calculator.ts";
import { echoShape } from "@/core/tools/echo.ts";
import { getTimeShape } from "@/core/tools/get_time.ts";
import { getWeatherShape } from "@/core/tools/get_weather.ts";
import { errMsg } from "@/core/util.ts";

/**
 * Server key for the in-process MCP server carrying our own tools. It becomes
 * the `{server}` segment of `mcp__{server}__{tool}`, which is the name the
 * model actually calls.
 */
export const BUILTINS_SERVER = "builtins";

/**
 * The element type of `createSdkMcpServer`'s `tools` array, derived from the
 * function rather than written out — the SDK declares it as
 * `SdkMcpToolDefinition<any>`, and deriving it avoids an explicit `any` here.
 */
type SdkTool = NonNullable<
  Parameters<typeof createSdkMcpServer>[0]["tools"]
>[number];

/**
 * The raw Zod shapes, keyed by tool name. These are the *same* declarations
 * `defineTool` wraps in `z.object(...)` for `bun run dev`, so the two surfaces
 * cannot drift.
 */
const SHAPES = {
  echo: echoShape,
  get_time: getTimeShape,
  calculator: calculatorShape,
  get_weather: getWeatherShape,
} satisfies Record<BuiltinToolName, object>;

/**
 * Wrap one built-in as an Agent SDK tool. `run` and `description` come from
 * `BUILTIN_TOOLS` untouched; `parse` is deliberately skipped because the
 * in-process MCP server already validated `args` against the same Zod shape.
 */
function bridge(name: BuiltinToolName): SdkTool {
  const builtin = BUILTIN_TOOLS[name];
  return tool(
    name,
    builtin.description ?? name,
    SHAPES[name],
    async (args) => {
      try {
        return {
          content: [{ type: "text" as const, text: await builtin.run(args) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errMsg(err) }],
          isError: true,
        };
      }
    },
    {
      // Without this, tool search defers the schema out of the initial prompt.
      // A four-tool demo wants them all loaded up front.
      alwaysLoad: true,
      annotations: { readOnlyHint: !MUTATING_TOOLS.has(name) },
    },
  );
}

/**
 * Build the in-process MCP server exposing the selected built-ins plus, when
 * `memoryDir` is set, the memory tool. Returns the config object that goes
 * straight into `Options.mcpServers`.
 */
export function createBuiltinsServer(opts: {
  tools?: "all" | readonly BuiltinToolName[];
  memoryDir?: string;
}) {
  const tools: SdkTool[] = [];
  if (opts.tools !== undefined) {
    for (const selected of selectTools(opts.tools)) {
      tools.push(bridge(selected.name as BuiltinToolName));
    }
  }
  if (opts.memoryDir !== undefined) tools.push(memoryTool(opts.memoryDir));

  return createSdkMcpServer({
    name: BUILTINS_SERVER,
    version: "0.1.0",
    tools,
    instructions:
      "Demo tools from the testing-anthropic repo. Prefer them over guessing at answers they can compute.",
  });
}

const QUALIFIED_PREFIX = `mcp__${BUILTINS_SERVER}__`;

/** The fully-qualified name a built-in reaches the model under. */
export function qualified(name: string) {
  return `${QUALIFIED_PREFIX}${name}`;
}

/**
 * Inverse of `qualified`, for `[tool]` traces and the mutating-tool check.
 * Leaves names from other MCP servers alone.
 */
export function unqualify(name: string) {
  return name.startsWith(QUALIFIED_PREFIX)
    ? name.slice(QUALIFIED_PREFIX.length)
    : name;
}
