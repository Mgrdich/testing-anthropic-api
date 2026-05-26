import type Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline/promises";
import {
  addAssistantMessage,
  addUserMessage,
  type MessageParam,
} from "@/core/index.ts";
import type { Args } from "@/cli/args.ts";

type TurnOpts = {
  client: Anthropic;
  messages: MessageParam[];
  args: Args;
  text: string;
};

export async function sendTurn(opts: TurnOpts): Promise<void> {
  addUserMessage(opts.messages, opts.text);
  const response = await addAssistantMessage(opts.client, opts.messages, {
    model: opts.args.model,
    max_tokens: opts.args.maxTokens,
    system: opts.args.system,
  });
  for (const block of response.content) {
    if (block.type === "text") {
      process.stdout.write(block.text);
    }
  }
  process.stdout.write("\n");
}

type ReplOpts = {
  client: Anthropic;
  messages: MessageParam[];
  args: Args;
  hadInitialTurn: boolean;
};

export async function runRepl(opts: ReplOpts): Promise<void> {
  process.stdout.write(
    opts.hadInitialTurn
      ? "\n(conversational mode — empty line or 'exit' to quit)\n"
      : "Conversational mode. Type your message; empty line or 'exit' to quit.\n",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question("> ")).trim();
      } catch {
        break; // Ctrl+C / Ctrl+D
      }
      if (!line || line === "exit" || line === "quit") break;
      await sendTurn({
        client: opts.client,
        messages: opts.messages,
        args: opts.args,
        text: line,
      });
    }
  } finally {
    rl.close();
  }
}
