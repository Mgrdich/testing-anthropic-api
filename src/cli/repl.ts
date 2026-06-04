import type Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline/promises";
import {
  addAssistantMessage,
  addUserMessage,
  MUTATING_TOOLS,
  runAgenticTurn,
  runAgenticTurnSdk,
  selectTools,
  streamAssistantMessage,
  type AgenticHooks,
  type MessageParam,
} from "@/core/index.ts";
import type { Args } from "@/cli/args.ts";

type TurnOpts = {
  messages: MessageParam[];
  args: Args;
  text: string;
  rl?: readline.Interface;
};

const TOOL_RESULT_PREVIEW_MAX = 200;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildAgenticHooks(
  args: Args,
  rl: readline.Interface | undefined,
): AgenticHooks {
  return {
    onStream: (stream) => {
      if (args.debug) {
        stream.on("streamEvent", (event) => {
          debug(`stream event ${event.type}`, event);
        });
        stream.on("error", (err) => {
          debug("stream error", { message: String(err) });
        });
      }
      stream.on("text", (delta) => process.stdout.write(delta));
    },
    onRound: (info) => {
      if (args.debug) debug("agentic round", info);
    },
    onToolCall: (name, input) => {
      process.stdout.write("\n");
      process.stderr.write(`[tool] ${name}(${compactJson(input)})\n`);
      if (args.debug) debug("tool call", { name, input });
    },
    onToolResult: (name, result, isError) => {
      const sigil = isError ? "✗" : "→";
      const shown = args.debug ? result : truncate(result, TOOL_RESULT_PREVIEW_MAX);
      // Prefix with the tool name so concurrent results stay readable
      // when multiple tools fire in one round.
      process.stderr.write(`  ${sigil} ${name}: ${shown}\n`);
      if (args.debug) debug("tool result", { name, result, isError });
    },
    isMutating: (name) => MUTATING_TOOLS.has(name),
    approveMutating: async (name, input) => {
      if (!rl) {
        throw new Error(
          `mutating tool '${name}' requires an interactive TTY for approval; not supported in --once / piped mode`,
        );
      }
      const ans = (
        await rl.question(`approve ${name}(${compactJson(input)})? [y/N] `)
      )
        .trim()
        .toLowerCase();
      return ans === "y" || ans === "yes";
    },
  };
}

const DEBUG_SEPARATOR = `${"-".repeat(60)}\n`;

function debug(label: string, payload: unknown): void {
  process.stderr.write(`\n${DEBUG_SEPARATOR}`);
  process.stderr.write(`[debug] ${label} ${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(DEBUG_SEPARATOR);
}

export async function sendTurn(opts: TurnOpts) {
  addUserMessage(opts.messages, opts.text);

  const requestOpts = {
    model: opts.args.model,
    max_tokens: opts.args.maxTokens,
    system: opts.args.system,
    temperature: opts.args.temperature,
    stop_sequences: opts.args.stopSequences,
  };

  if (opts.args.debug) {
    debug("request", {
      ...requestOpts,
      messages: opts.messages.length,
      tools: opts.args.tools,
    });
  }

  if (opts.args.tools) {
    const tools = selectTools(opts.args.tools);
    const hooks = buildAgenticHooks(opts.args, opts.rl);
    const runner = opts.args.runner === "sdk" ? runAgenticTurnSdk : runAgenticTurn;
    const finalResponse = await runner(
      opts.messages,
      { ...requestOpts, max_iterations: opts.args.maxIterations },
      tools,
      hooks,
    );
    if (opts.args.debug) debug("final response", finalResponse);
    process.stdout.write("\n");
    if (finalResponse.stop_reason === "tool_use") {
      // runAgenticTurn returns a tool_use response only when the
      // max_iterations cap fires — the model still wanted to call more tools.
      process.stderr.write(
        `warning: --max-iterations cap (${opts.args.maxIterations}) reached; model still wanted to call tools\n`,
      );
    }
    return;
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

export async function runRepl(opts: ReplOpts) {
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
        rl,
      });
    }
  } finally {
    rl.close();
  }
}
