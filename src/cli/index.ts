import { errMsg, type MessageParam } from "@/core/index.ts";
import { type Args, parseArgs, printHelp } from "@/cli/args.ts";
import { runRepl, sendTurn } from "@/cli/repl.ts";
import { readStdin } from "@/cli/stdin.ts";

export async function runCli(argv: readonly string[]): Promise<void> {
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

  const messages: MessageParam[] = [];

  const initial = args.prompt ?? (await readStdin());
  if (initial) {
    await sendTurn({ messages, args, text: initial });
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
  });
}
