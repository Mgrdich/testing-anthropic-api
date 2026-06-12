import type Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline/promises";
import {
  addAssistantMessage,
  addUserMessage,
  Debug,
  errMsg,
  MUTATING_TOOLS,
  runAgenticTurn,
  runAgenticTurnSdk,
  selectTools,
  streamAssistantMessage,
  type AgenticHooks,
  type MessageParam,
  type Tool,
} from "@/core/index.ts";
import {
  getPromptMessages,
  listMcpPrompts,
  readResourceBlock,
  resourceBlockText,
  type McpConnection,
} from "@/mcp/index.ts";
import type { Args } from "@/cli/args.ts";

const dbg = Debug.get();

type TurnOpts = {
  messages: MessageParam[];
  args: Args;
  text: string;
  rl?: readline.Interface;
  mcp?: McpConnection;
  mcpTools?: Tool[];
};

const TOOL_RESULT_PREVIEW_MAX = 200;

function truncate(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildAgenticHooks(
  rl: readline.Interface | undefined,
): AgenticHooks {
  return {
    onStream: (stream) => {
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
    onRound: (info) => {
      dbg.json("agentic round", info);
    },
    onToolCall: (name, input) => {
      process.stdout.write("\n");
      process.stderr.write(`[tool] ${name}(${compactJson(input)})\n`);
      dbg.json("tool call", { name, input });
    },
    onToolResult: (name, result, isError) => {
      const sigil = isError ? "✗" : "→";
      const shown = dbg.enabled ? result : truncate(result, TOOL_RESULT_PREVIEW_MAX);
      // Prefix with the tool name so concurrent results stay readable
      // when multiple tools fire in one round.
      process.stderr.write(`  ${sigil} ${name}: ${shown}\n`);
      dbg.json("tool result", { name, result, isError });
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

/** Parse `key=value key="multi word"` pairs from a slash-command tail. */
function parsePromptArgs(rest: string) {
  const args: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1];
    if (key) args[key] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return args;
}

/**
 * Handle a `/...` line as an MCP prompt invocation. `/prompts` (or `/help`)
 * lists what the server offers; `/<name> key=value …` fetches the prompt and
 * appends its (already XML-tagged) messages to the history. Returns true when
 * a turn was queued and the caller should proceed to the API request.
 */
async function handleMcpSlash(
  opts: TurnOpts,
  mcp: McpConnection,
) {
  const space = opts.text.indexOf(" ");
  const name = (
    space === -1 ? opts.text.slice(1) : opts.text.slice(1, space)
  ).trim();
  const rest = space === -1 ? "" : opts.text.slice(space + 1).trim();

  if (!mcp.alive) {
    process.stderr.write("error: MCP server is no longer running\n");
    return false;
  }

  try {
    if (name === "prompts" || name === "help" || name === "") {
      const prompts = await listMcpPrompts(mcp.client);
      process.stderr.write("MCP prompts (invoke with /<name> key=value …):\n");
      for (const p of prompts) {
        const argList = p.args.map((a) => `${a}=…`).join(" ");
        const desc = p.description ? ` — ${p.description}` : "";
        process.stderr.write(`  /${p.name} ${argList}${desc}\n`);
      }
      return false;
    }

    const promptMessages = await getPromptMessages(
      mcp.client,
      name,
      parsePromptArgs(rest),
    );
    if (promptMessages.length === 0) {
      process.stderr.write(`error: MCP prompt '/${name}' returned no messages\n`);
      return false;
    }
    opts.messages.push(...promptMessages);
    return true;
  } catch (err) {
    process.stderr.write(`error: MCP prompt '/${name}' failed: ${errMsg(err)}\n`);
    return false;
  }
}

// Either a full URI (docs://path/to/doc.md) or a bare name/path. The bare
// form allows dotted extensions but must end on an alphanumeric run after
// the dot, so a sentence-final "@doc.md." captures "doc.md" without the
// trailing period.
const MENTION_RE =
  /@([A-Za-z0-9_-]+:\/\/[^\s]+|[A-Za-z0-9/_-]+(?:\.[A-Za-z0-9]+)*)/g;

/**
 * Build the user-turn content for a line that may carry `@resource`
 * mentions. Each resolvable mention is fetched from the MCP server and sent
 * as its own content block, wrapped in XML tags (matching the rag prompt
 * style); the user's text follows as the final block. Unresolvable mentions
 * warn and stay literal. Lines without mentions pass through as plain text.
 */
async function buildMentionContent(
  mcp: McpConnection,
  text: string,
) {
  const refs = [
    ...new Set(
      [...text.matchAll(MENTION_RE)]
        .map((m) => m[1])
        .filter((r): r is string => r !== undefined),
    ),
  ];
  if (refs.length === 0) return text;
  if (!mcp.alive) {
    process.stderr.write(
      "warning: MCP server is no longer running; sending @mentions as literal text\n",
    );
    return text;
  }

  const blocks: Exclude<MessageParam["content"], string> = [];
  for (const ref of refs) {
    try {
      const { uri, block } = await readResourceBlock(mcp.client, ref);
      const text = resourceBlockText(block);
      if (text !== undefined) {
        blocks.push({
          type: "text",
          text: `<resource uri="${uri}">\n${text}\n</resource>`,
        });
      } else {
        // Non-text resources (image/PDF) go through as-is — one cast at the
        // beta → non-beta wire boundary, same JSON shape.
        blocks.push(block as unknown as (typeof blocks)[number]);
      }
      process.stderr.write(`[mcp] attached resource ${uri}\n`);
    } catch (err) {
      process.stderr.write(
        `warning: could not fetch MCP resource '@${ref}': ${errMsg(err)}\n`,
      );
    }
  }
  if (blocks.length === 0) return text;
  blocks.push({ type: "text", text });
  return blocks;
}

export async function sendTurn(opts: TurnOpts) {
  if (opts.mcp && opts.text.startsWith("/")) {
    const queued = await handleMcpSlash(opts, opts.mcp);
    if (!queued) return;
  } else if (opts.mcp) {
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
    const runner = opts.args.runner === "sdk" ? runAgenticTurnSdk : runAgenticTurn;
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
  mcp?: McpConnection;
  mcpTools?: Tool[];
};

export async function runRepl(opts: ReplOpts) {
  process.stdout.write(
    opts.hadInitialTurn
      ? "\n(conversational mode — empty line, 'exit', or 'quit' to leave)\n"
      : "Conversational mode. Type your message; empty line, 'exit', or 'quit' to leave.\n",
  );
  if (opts.mcp) {
    process.stdout.write(
      "MCP connected: /prompts lists prompts, /<name> key=value invokes one, @<resource> attaches a resource.\n",
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
