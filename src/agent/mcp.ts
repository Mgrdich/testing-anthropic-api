import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentArgs } from "@/agent/args.ts";
import { selectServers } from "@/mcp/index.ts";

/**
 * Turn `--mcp` / `--mcp-url` into `Options.mcpServers`.
 *
 * The registry (`MCP_SERVERS`), the name validation, and the flag parsing all
 * survive from `bun run dev`; what disappears is every line of connection
 * code. `connectMcpServer`, `connectMcpServerHttp`, the handshake timeout,
 * liveness tracking, `loadMcpTools`, `mcpRunnableTools`, and the duplicate
 * tool-name guard are all the SDK's problem now — and name collisions become
 * structurally impossible, since every tool arrives as
 * `mcp__{serverKey}__{tool}`.
 *
 * Two capabilities do NOT survive, because the SDK has no client-side surface
 * for them (see `src/agent/CLAUDE.md`):
 *   - `sampling/createMessage` — the research server always falls back to its
 *     raw Wikipedia extract.
 *   - `roots/list` — the docs server always uses its hardcoded fallback dir.
 */
export function buildMcpServerConfigs(
  args: AgentArgs,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  if (args.mcp !== undefined) {
    for (const spec of selectServers(args.mcp)) {
      // `type: "stdio"` is the default and may be omitted.
      servers[spec.name] = {
        command: "bun",
        args: ["run", spec.scriptPath],
      };
    }
  }

  for (const url of args.mcpUrls ?? []) {
    // Key off the host:port so two URLs cannot collide, and so the name that
    // shows up in `mcp__<key>__<tool>` is recognizable.
    const parsed = new URL(url);
    const key = `http_${parsed.host.replace(/[^a-zA-Z0-9]/g, "_")}`;
    servers[key] = { type: "http", url };
  }

  return servers;
}
