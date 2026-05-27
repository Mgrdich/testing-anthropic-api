import type Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline/promises";
import {
  addAssistantMessage,
  addUserMessage,
  streamAssistantMessage,
  type MessageParam,
} from "@/core/index.ts";
import type { Args } from "@/cli/args.ts";

type TurnOpts = {
  messages: MessageParam[];
  args: Args;
  text: string;
};

const DEBUG_SEPARATOR = `${"-".repeat(60)}\n`;

function debug(label: string, payload: unknown): void {
  process.stderr.write(`\n${DEBUG_SEPARATOR}`);
  process.stderr.write(`[debug] ${label} ${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(DEBUG_SEPARATOR);
}

export async function sendTurn(opts: TurnOpts): Promise<void> {
  addUserMessage(opts.messages, opts.text);

  const requestOpts = {
    model: opts.args.model,
    max_tokens: opts.args.maxTokens,
    system: opts.args.system,
    temperature: opts.args.temperature,
    stop_sequences: opts.args.stopSequences,
  };

  if (opts.args.debug) {
    debug("request", { ...requestOpts, messages: opts.messages.length });
  }

  if (opts.args.prefill) {
    process.stdout.write(opts.args.prefill);
  }

  let response: Anthropic.Message;
  if (opts.args.stream) {
    response = await streamAssistantMessage(
      opts.messages,
      requestOpts,
      (stream) => {
        if (opts.args.debug) {
          stream.on("streamEvent", (event) => {
            debug(`stream event ${event.type}`, event);
          });
          stream.on("error", (err) => {
            debug("stream error", { message: String(err) });
          });
        }
        stream.on("text", (delta) => process.stdout.write(delta));
      },
      opts.args.prefill,
    );
  } else {
    response = await addAssistantMessage(
      opts.messages,
      requestOpts,
      opts.args.prefill,
    );
  }

  if (opts.args.debug) {
    debug("response", response);
  }

  const unhandled: typeof response.content = [];
  for (const block of response.content) {
    if (block.type === "text") {
      if (!opts.args.stream) {
        process.stdout.write(block.text);
      }
    } else {
      unhandled.push(block);
    }
  }
  process.stdout.write("\n");

  // TODO will be handled later
  if (unhandled.length > 0) {
    const kinds = unhandled.map((b) => b.type).join(", ");
    process.stderr.write(
      `warning: ${unhandled.length} non-text block(s) not rendered: ${kinds}\n`,
    );
  }
}

type ReplOpts = {
  messages: MessageParam[];
  args: Args;
  hadInitialTurn: boolean;
};

export async function runRepl(opts: ReplOpts): Promise<void> {
  process.stdout.write(
    opts.hadInitialTurn
      ? "\n(conversational mode — empty line, 'exit', or 'quit' to leave)\n"
      : "Conversational mode. Type your message; empty line, 'exit', or 'quit' to leave.\n",
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
        messages: opts.messages,
        args: opts.args,
        text: line,
      });
    }
  } finally {
    rl.close();
  }
}
