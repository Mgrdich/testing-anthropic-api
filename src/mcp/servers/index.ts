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

// `satisfies` (not `: Record<string, McpServerSpec>`) so the literal keys
// survive in the type — `McpServerName` is derived from them, and the CLI
// parser validates `--mcp` names against this set.
export const MCP_SERVERS = {
  docs: { name: "docs", scriptPath: entry("docs-server.ts") },
  research: { name: "research", scriptPath: entry("research-server.ts") },
} satisfies Record<string, McpServerSpec>;

/** The name of a registered MCP server — the keys of `MCP_SERVERS`. */
export type McpServerName = keyof typeof MCP_SERVERS;

/** Runtime narrow of an arbitrary string to a registered server name. */
export function isMcpServerName(name: string): name is McpServerName {
  return name in MCP_SERVERS;
}

/**
 * Resolve a `--mcp` filter to server specs. `"all"` returns every registered
 * server; a name list maps to its specs. Names are validated at the CLI
 * boundary (see `cli/args.ts`), mirroring `selectTools`.
 */
export function selectServers(filter: "all" | readonly McpServerName[]) {
  if (filter === "all") return Object.values(MCP_SERVERS);
  return filter.map((name) => MCP_SERVERS[name]);
}
