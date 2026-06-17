import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type { Args } from "@/cli/args.ts";
import { buildAgenticHooks } from "@/cli/hooks.ts";
import {
  buildMentionContent,
  handleMcpPrompt,
  MENTION_PREFIX,
  PROMPT_PREFIX,
} from "@/cli/mcp-turn.ts";
import {
  addAssistantMessage,
  addUserMessage,
  Debug,
  type MessageParam,
  runAgenticTurn,
  runAgenticTurnSdk,
  selectTools,
  streamAssistantMessage,
  type Tool,
} from "@/core/index.ts";
import type { McpConnection } from "@/mcp/index.ts";

const dbg = Debug.get();

type TurnOpts = {
  messages: MessageParam[];
  args: Args;
  text: string;
  rl?: readline.Interface;
  mcp?: McpConnection[];
  mcpTools?: Tool[];
};

export async function sendTurn(opts: TurnOpts) {
  if (opts.mcp?.length && opts.text.startsWith(PROMPT_PREFIX)) {
    const queued = await handleMcpPrompt(opts.mcp, opts.text, opts.messages);
    if (!queued) return;
  } else if (opts.mcp?.length) {
    const content = await buildMentionContent(opts.mcp, opts.text);
    opts.messages.push({ role: "user", content });
  } else {
    addUserMessage(opts.messages, opts.text);
  }

  const requestOpts = {
    model: opts.args.model,
    max_tokens: opts.args.maxTokens,
    system: opts.args.system,
    temperature: opts.args.temperature,
    stop_sequences: opts.args.stopSequences,
  };

  dbg.json("request", {
    ...requestOpts,
    messages: opts.messages.length,
    tools: opts.args.tools,
  });

  const tools = [
    ...(opts.args.tools ? selectTools(opts.args.tools) : []),
    ...(opts.mcpTools ?? []),
  ];
  if (tools.length > 0) {
    // The API rejects duplicate tool names; fail loudly if an MCP tool ever
    // shadows a built-in (the bundled server's names are chosen not to).
    const seen = new Set<string>();
    for (const t of tools) {
      if (seen.has(t.name)) {
        throw new Error(
          `duplicate tool name '${t.name}' between built-in and MCP tools`,
        );
      }
      seen.add(t.name);
    }
    const hooks = buildAgenticHooks(opts.rl);
    const runner =
      opts.args.runner === "sdk" ? runAgenticTurnSdk : runAgenticTurn;
    const finalResponse = await runner(
      opts.messages,
      { ...requestOpts, max_iterations: opts.args.maxIterations },
      tools,
      hooks,
    );
    dbg.json("final response", finalResponse);
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
        if (dbg.enabled) {
          stream.on("streamEvent", (event) => {
            dbg.json(`stream event ${event.type}`, event);
          });
          stream.on("error", (err) => {
            dbg.json("stream error", { message: String(err) });
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

  dbg.json("response", response);

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
  mcp?: McpConnection[];
  mcpTools?: Tool[];
};

export async function runRepl(opts: ReplOpts) {
  process.stdout.write(
    opts.hadInitialTurn
      ? "\n(conversational mode — empty line, 'exit', or 'quit' to leave)\n"
      : "Conversational mode. Type your message; empty line, 'exit', or 'quit' to leave.\n",
  );
  if (opts.mcp?.length) {
    const names = opts.mcp.map((c) => c.name).join(", ");
    process.stdout.write(
      `MCP connected (${names}): ${PROMPT_PREFIX}prompts lists prompts, ${PROMPT_PREFIX}<name> key=value invokes one, ${MENTION_PREFIX}<resource> attaches a resource.\n`,
    );
  }

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
        mcp: opts.mcp,
        mcpTools: opts.mcpTools,
      });
    }
  } finally {
    rl.close();
  }
}
