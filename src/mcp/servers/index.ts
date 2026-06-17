/**
 * Registry of the standalone stdio MCP servers this CLI can spawn. The
 * single source of truth for which servers exist and where their entry files
 * live; `connectMcpServers()` and the `--mcp` flag select from here.
 *
 * Mirrors `selectTools` / `BUILTIN_TOOLS` in `core/tools/builtins.ts`: a bare
 * `--mcp` connects every server, `--mcp docs,research` a named subset.
 */
export type McpServerSpec = {
  /** Logical id used by `--mcp <names>` selection and in diagnostics. */
  name: string;
  /** Absolute path to the server's stdio entry file (`bun run <path>`). */
  scriptPath: string;
};

/** Resolve a sibling server entry to an absolute path (cwd-independent). */
function entry(file: string) {
  return new URL(`./${file}`, import.meta.url).pathname;
}

export const MCP_SERVERS: Record<string, McpServerSpec> = {
  docs: { name: "docs", scriptPath: entry("docs-server.ts") },
  research: { name: "research", scriptPath: entry("research-server.ts") },
};

/**
 * Resolve a `--mcp` filter to server specs. `"all"` returns every registered
 * server; a name list looks each up, throwing on an unknown name (mirrors
 * `selectTools`).
 */
export function selectServers(filter: "all" | readonly string[]) {
  if (filter === "all") return Object.values(MCP_SERVERS);

  const known = Object.keys(MCP_SERVERS).join(", ");

  return filter.map((name) => {
    const spec = MCP_SERVERS[name];
    if (!spec) {
      throw new Error(`unknown MCP server: ${name} (known: ${known})`);
    }
    return spec;
  });
}
