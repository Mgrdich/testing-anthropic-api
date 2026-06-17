import { type Args, parseArgs, printHelp } from "@/cli/args.ts";
import { runRepl, sendTurn } from "@/cli/repl.ts";
import { readStdin } from "@/cli/stdin.ts";
import { Debug, errMsg, type MessageParam, type Tool } from "@/core/index.ts";
import {
  connectMcpServers,
  loadMcpTools,
  type McpConnection,
  selectServers,
} from "@/mcp/index.ts";

export async function runCli(argv: readonly string[]) {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${errMsg(err)}\n\n`);
    printHelp();
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (args.debug) Debug.get().enable();

  // --mcp was an explicit ask: if a server won't start, fail loudly rather
  // than silently degrading to a tool-less session.
  let mcp: McpConnection[] | undefined;
  let mcpTools: Tool[] | undefined;
  if (args.mcp) {
    try {
      mcp = await connectMcpServers(selectServers(args.mcp));
      const perServer = await Promise.all(
        mcp.map((conn) => loadMcpTools(conn.client)),
      );
      mcpTools = perServer.flat();
    } catch (err) {
      await Promise.all((mcp ?? []).map((c) => c.close().catch(() => {})));
      process.stderr.write(
        `error: failed to start MCP server: ${errMsg(err)}\n`,
      );
      process.exit(1);
    }
  }

  try {
    const messages: MessageParam[] = [];

    const initial = args.prompt ?? (await readStdin());
    if (initial) {
      await sendTurn({ messages, args, text: initial, mcp, mcpTools });
    }

    // No REPL if stdin isn't interactive or the user asked for a single shot.
    if (!process.stdin.isTTY || args.once) {
      if (args.once && !initial) {
        process.stderr.write(
          "error: --once requires a prompt (positional argument or piped stdin)\n",
        );
        process.exit(2);
      }
      return;
    }

    await runRepl({
      messages,
      args,
      hadInitialTurn: Boolean(initial),
      mcp,
      mcpTools,
    });
  } finally {
    await Promise.all((mcp ?? []).map((c) => c.close()));
  }
}
