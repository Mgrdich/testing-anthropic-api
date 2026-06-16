import {
  type MCPClientLike,
  type MCPToolLike,
  mcpTools,
} from "@anthropic-ai/sdk/helpers/beta/mcp";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type {
  BetaTool,
  BetaToolResultContentBlockParam,
} from "@anthropic-ai/sdk/resources/beta";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Debug, type Tool } from "@/core/index.ts";

/**
 * Guard: the MCP SDK `Client` satisfies the Anthropic helpers'
 * `MCPClientLike` contract. The two don't match structurally only because
 * `Client.callTool`'s declared return type is a union that includes a legacy
 * `{ toolResult }` shape (selected by an optional compatibility
 * result-schema argument the helpers never pass) — at runtime the default
 * schema always yields `{ content }`. The predicate verifies the method
 * exists and narrows in one sanctioned place instead of a bare cast.
 */
export function isMcpClientLike(
  client: Client,
): client is Client & MCPClientLike {
  return typeof client.callTool === "function";
}

/**
 * Guard the client (see `isMcpClientLike`) and hand off to the SDK's
 * `mcpTools()` in one place. Consumers wrap the returned runnable tools
 * differently — `loadMcpTools` adapts them to the local `Tool` contract,
 * `cli.ts` keeps full block fidelity and adds stderr logging — but the
 * guard-then-convert step is shared here.
 */
export function mcpRunnableTools(
  tools: MCPToolLike[],
  client: Client,
): BetaRunnableTool<Record<string, unknown>>[] {
  if (!isMcpClientLike(client)) {
    throw new Error(
      "MCP client does not satisfy the Anthropic SDK's MCPClientLike contract (missing callTool)",
    );
  }
  return mcpTools(tools, client);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Guard: a converted runnable tool is the plain custom-tool variant our
 * local `Tool` type is built on. `BetaRunnableTool` is a union of ~10 tool
 * shapes (bash, computer use, text editors, …); `mcpTool()` only ever
 * produces the custom variant, which is the one carrying `input_schema`.
 */
function isCustomRunnableTool(
  rt: BetaRunnableTool<Record<string, unknown>>,
): rt is BetaRunnableTool<Record<string, unknown>> & BetaTool {
  return "input_schema" in rt && rt.input_schema.type === "object";
}

/**
 * Flatten a runnable tool's result into the string our local `Tool.run`
 * contract requires. The SDK's `mcpTool` run returns either a JSON string
 * (structured-content-only results) or an array of tool-result content
 * blocks. Text blocks pass through verbatim; anything else (image, document)
 * degrades to a `[type]` placeholder — fine for the bundled text-only tools,
 * documented in src/mcp/CLAUDE.md for future non-text tools.
 */
function flattenResult(out: string | BetaToolResultContentBlockParam[]) {
  if (typeof out === "string") return out;
  return out
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n");
}

/**
 * List the server's tools and convert them for our agentic loops.
 *
 * The conversion itself is the Anthropic SDK's `mcpTools()` helper, which
 * yields `BetaRunnableTool`s (each `run` proxies to `client.callTool`). We
 * then narrow each to the local `Tool` shape via the guards above, so MCP
 * tools flow through both `runAgenticTurn` and `runAgenticTurnSdk`
 * unchanged.
 */
export async function loadMcpTools(client: Client): Promise<Tool[]> {
  // Annotated: checks the adapter literal against the local Tool contract
  // here, instead of erroring at whichever runner consumes it.
  const { tools } = await client.listTools();
  Debug.get().json("mcp tools", () => tools.map((t) => t.name));
  return mcpRunnableTools(tools, client).map((rt) => {
    if (!isCustomRunnableTool(rt)) {
      throw new Error("mcpTools() produced a non-custom tool variant");
    }
    return {
      ...rt,
      run: async (input: unknown) => {
        if (!isRecord(input)) {
          throw new Error(`tool input must be an object, got ${typeof input}`);
        }
        return flattenResult(await rt.run(input));
      },
    };
  });
}
