import type { RlRef } from "@/agent/approve.ts";
import { parseAgentArgs, printAgentHelp } from "@/agent/args.ts";
import { runAgentRepl } from "@/agent/repl.ts";
import { startAgentSession } from "@/agent/session.ts";
import { readStdin } from "@/cli/stdin.ts";
import { Debug } from "@/core/index.ts";

/**
 * The agent CLI's `runCli`. Compare `src/cli/index.ts`: there is no MCP
 * connect/close block (the SDK owns it), no `messages` array, and no per-turn
 * branch — just one session that spans every turn.
 */
export async function runAgentCli(argv: readonly string[]) {
  let args: ReturnType<typeof parseAgentArgs>;
  try {
    args = parseAgentArgs(argv);
  } catch (err) {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n\n`,
    );
    printAgentHelp();
    process.exit(2);
  }

  if (args.help) {
    printAgentHelp();
    return;
  }
  if (args.debug) Debug.get().enable();

  const rlRef: RlRef = {};
  const session = startAgentSession(args, rlRef);

  try {
    const initial = args.prompt ?? (await readStdin());
    if (initial) await session.send(initial);

    if (!process.stdin.isTTY || args.once) return;

    await runAgentRepl({
      session,
      args,
      rlRef,
      hadInitialTurn: Boolean(initial),
    });
  } finally {
    // Covers every REPL exit path (empty line, exit/quit, Ctrl+C/D) and any
    // throw out of a turn — the subprocess must not outlive us.
    await session.close();
  }
}
