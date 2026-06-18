/**
 * Client side of the MCP integration: connecting to servers, answering their
 * sampling requests, and converting their tools/prompts/resources for Claude
 * via the Anthropic SDK's `helpers/beta/mcp`. The counterpart to `servers/`
 * (the standalone, key-free stdio server entries).
 */
export type { McpConnection } from "@/mcp/client/connection.ts";
export {
  connectDocsServer,
  connectMcpServer,
  connectMcpServers,
  McpConnectError,
} from "@/mcp/client/connection.ts";
export type { McpPromptInfo } from "@/mcp/client/prompts.ts";
export {
  getPromptMessages,
  listMcpPrompts,
} from "@/mcp/client/prompts.ts";
export type {
  McpResourceBlock,
  McpResourceInfo,
} from "@/mcp/client/resources.ts";
export {
  listMcpResources,
  readResourceBlock,
  resourceBlockText,
} from "@/mcp/client/resources.ts";
export { installRootsHandler } from "@/mcp/client/roots.ts";
export { installSamplingHandler } from "@/mcp/client/sampling.ts";
export {
  isMcpClientLike,
  loadMcpTools,
  mcpRunnableTools,
} from "@/mcp/client/tools.ts";
