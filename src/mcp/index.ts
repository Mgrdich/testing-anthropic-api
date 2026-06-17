// Public surface of the MCP module: the client side (connecting, sampling,
// conversion helpers) and the server registry. External callers import from
// here, not the `client/` or `servers/` subfolders.
export * from "@/mcp/client/index.ts";
export type { McpServerName, McpServerSpec } from "@/mcp/servers/index.ts";
export {
  isMcpServerName,
  MCP_SERVERS,
  selectServers,
} from "@/mcp/servers/index.ts";
