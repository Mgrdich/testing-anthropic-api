import * as readline from "node:readline/promises";
import type { RlRef } from "@/agent/approve.ts";
import type { AgentArgs } from "@/agent/args.ts";
import type { AgentSession } from "@/agent/session.ts";

type ReplOpts = {
  session: AgentSession;
  args: AgentArgs;
  rlRef: RlRef;
  hadInitialTurn: boolean;
};

/**
 * The readline loop. Structurally the same as `src/cli/repl.ts`'s, minus the
 * `messages` array — history is the SDK's, so a turn is just `session.send`.
 *
 * Two things are new and free: Ctrl+C interrupts the *turn* rather than
 * killing the process, and `/model <id>` retargets mid-session.
 */
export async function runAgentRepl(opts: ReplOpts) {
  process.stdout.write(
    opts.hadInitialTurn
      ? "\n(conversational mode — empty line, 'exit', or 'quit' to leave)\n"
      : "Conversational mode. Type your message; empty line, 'exit', or 'quit' to leave.\n",
  );
  const sid = opts.session.sessionId();
  if (sid) process.stdout.write(`session: ${sid}\n`);
  process.stdout.write(
    "Commands: /model <id> switches model, Ctrl+C interrupts the current turn.\n",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // Hand the interface to the approval gate for the life of the REPL.
  opts.rlRef.current = rl;

  // Ctrl+C interrupts the running turn instead of tearing down the process.
  // A second one at an idle prompt still exits via the question() rejection.
  rl.on("SIGINT", () => {
    process.stderr.write("\n[interrupt] stopping the current turn…\n");
    void opts.session.interrupt();
  });

  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question("> ")).trim();
      } catch {
        break; // Ctrl+C at the prompt / Ctrl+D
      }
      if (!line || line === "exit" || line === "quit") break;

      if (line.startsWith("/model ")) {
        const model = line.slice("/model ".length).trim();
        if (model) {
          await opts.session.handle.setModel(model);
          process.stderr.write(`[model] switched to ${model}\n`);
        }
        continue;
      }

      await opts.session.send(line);
    }
  } finally {
    opts.rlRef.current = undefined;
    rl.close();
  }
}
