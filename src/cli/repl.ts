import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type {
  BetaAdvisorToolResultBlock,
  BetaMessage,
} from "@anthropic-ai/sdk/resources/beta";
import type { Args } from "@/cli/args.ts";
import {
  attachThinkingListener,
  buildAgenticHooks,
  writeThinking,
} from "@/cli/hooks.ts";
import {
  buildMentionContent,
  handleMcpPrompt,
  MENTION_PREFIX,
  PROMPT_PREFIX,
} from "@/cli/mcp-turn.ts";
import {
  addAssistantMessage,
  addUserMessage,
  createMemoryTool,
  Debug,
  type MessageParam,
  PTC_CODE_EXECUTION_TOOL,
  PTC_TOOL_TYPE,
  runAgenticTurn,
  runAgenticTurnSdk,
  selectTools,
  streamAdvisorMessage,
  streamAssistantMessage,
  type Tool,
} from "@/core/index.ts";
import type { McpConnection } from "@/mcp/index.ts";

const dbg = Debug.get();

/**
 * Post-turn diagnostics, shared by the tools and single-shot branches.
 * Always-on: a `stop_reason === "refusal"` turn would otherwise print an
 * empty line silently — surface the null-guarded `stop_details` on stderr.
 * With `--cache`, also print the cache-verification line from the final
 * message's usage (read = cache hits, wrote = new cache entries, uncached =
 * full-price input tokens). Takes the beta/non-beta message union because
 * `--runner sdk` returns a BetaMessage; the fields read here are identical.
 */
function reportTurnOutcome(
  response: Anthropic.Message | BetaMessage,
  args: Args,
) {
  if (response.stop_reason === "refusal") {
    const details = response.stop_details;
    process.stderr.write(
      `refusal: model declined to answer (category: ${
        details?.category ?? "unknown"
      })${details?.explanation ? ` — ${details.explanation}` : ""}\n`,
    );
  }
  if (args.cache) {
    const u = response.usage;
    process.stderr.write(
      `[cache] read=${u.cache_read_input_tokens ?? 0} wrote=${
        u.cache_creation_input_tokens ?? 0
      } uncached=${u.input_tokens}\n`,
    );
  }
}

/**
 * Render one `advisor_tool_result` block to stderr (the advice is a
 * diagnostic, not model output — stdout stays answer-only). The block's
 * `content` is a three-member union and only one member carries `.text`, so
 * switch on the discriminator; never read `.text` unconditionally.
 */
function renderAdvisorResult(block: BetaAdvisorToolResultBlock) {
  const content = block.content;
  switch (content.type) {
    case "advisor_result":
      process.stderr.write(`[advisor] ${content.text}\n`);
      break;
    case "advisor_redacted_result":
      // The advisor's reasoning came back as an opaque blob (round-tripped
      // verbatim in history); there is nothing to show.
      process.stderr.write("[advisor] redacted\n");
      break;
    case "advisor_tool_result_error":
      process.stderr.write(
        `warning: advisor tool error (${content.error_code})\n`,
      );
      break;
  }
}

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
    // Both flow through the Partial<…> option types to every path — the
    // single-shot primitives and both agentic runners — with no core changes.
    // `display` is explicit because it defaults to "omitted" on 4.7+ models:
    // the blocks still arrive, but with empty text, so the [thinking] renderer
    // would print a prefix and nothing else.
    ...(opts.args.thinking
      ? {
          thinking: {
            type: "adaptive" as const,
            display: "summarized" as const,
          },
        }
      : {}),
    ...(opts.args.cache
      ? // Top-level auto-cache: the API places the breakpoint on the last
        // cacheable block. Simpler than manual 4-breakpoint management and
        // adequate here.
        { cache_control: { type: "ephemeral" as const } }
      : {}),
  };

  dbg.json("request", {
    ...requestOpts,
    messages: opts.messages.length,
    tools: opts.args.tools,
    memory: opts.args.memory,
    advisor: opts.args.advisor,
    ptc: opts.args.ptc,
  });

  // `--memory` appends the Anthropic-defined memory tool to whatever the
  // other flags selected, and is enough on its own to take the agentic
  // branch below (the tools path always streams and ignores --prefill).
  const tools = [
    ...(opts.args.tools ? selectTools(opts.args.tools) : []),
    ...(opts.mcpTools ?? []),
    ...(opts.args.memory === undefined
      ? []
      : [createMemoryTool(opts.args.memory)]),
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
    // Programmatic tool calling. `--ptc` is parse-time exclusive with
    // `--runner sdk`/`--mcp`/`--advisor`, so this only ever reaches the local
    // runner: the server-side code_execution entry rides alongside the
    // client-side tools, every client tool is restricted to being called from
    // inside that container, and `strict` is dropped (the API rejects strict
    // tool use under PTC, and defineTool sets it on every built-in).
    const ptcOpts = opts.args.ptc
      ? {
          server_tools: [PTC_CODE_EXECUTION_TOOL],
          allowed_callers: [PTC_TOOL_TYPE] as const,
          omit_strict: true,
        }
      : {};
    const runner =
      opts.args.runner === "sdk" ? runAgenticTurnSdk : runAgenticTurn;
    const finalResponse = await runner(
      opts.messages,
      {
        ...requestOpts,
        max_iterations: opts.args.maxIterations,
        ...ptcOpts,
      },
      tools,
      hooks,
    );
    dbg.json("final response", finalResponse);
    process.stdout.write("\n");
    reportTurnOutcome(finalResponse, opts.args);
    if (
      finalResponse.stop_reason === "tool_use" ||
      finalResponse.stop_reason === "pause_turn"
    ) {
      // Both are resumable stop reasons, so the loop returns them only when a
      // cap fired — the model still had work to do (another tool round, or
      // resuming a paused code-execution turn). Which cap depends: a paused
      // turn can also hit the runner's own consecutive-pause ceiling, which
      // applies even without --max-iterations.
      const cap =
        opts.args.maxIterations === undefined
          ? "consecutive pause_turn cap"
          : `--max-iterations cap (${opts.args.maxIterations})`;
      process.stderr.write(
        `warning: ${cap} reached; turn was not finished (stop_reason: ${finalResponse.stop_reason})\n`,
      );
    }
    return;
  }

  if (opts.args.advisor) {
    // Server-side advisor tool: one streaming beta call, no client-side tool
    // loop. Always streams (like the tools branch) and ignores --prefill.
    const advisorResponse = await streamAdvisorMessage(
      opts.messages,
      { ...requestOpts, advisor_model: opts.args.advisor },
      (stream) => {
        if (dbg.enabled) {
          stream.on("streamEvent", (event) => {
            dbg.json(`stream event ${event.type}`, event);
          });
          stream.on("error", (err) => {
            dbg.json("stream error", { message: String(err) });
          });
        }
        // The beta stream exposes the same event surface as MessageStream;
        // one cast at the boundary keeps the thinking renderer shared.
        attachThinkingListener(stream as unknown as MessageStream);
        stream.on("text", (delta) => process.stdout.write(delta));
      },
    );
    dbg.json("advisor response", advisorResponse);
    process.stdout.write("\n");
    for (const block of advisorResponse.content) {
      if (block.type === "advisor_tool_result") renderAdvisorResult(block);
    }
    reportTurnOutcome(advisorResponse, opts.args);
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
        attachThinkingListener(stream);
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
    } else if (block.type === "thinking") {
      // Streamed thinking was already rendered by attachThinkingListener;
      // on the non-streaming path render the complete block here. Either
      // way it's handled — keep it out of the "not rendered" warning.
      if (!opts.args.stream && block.thinking) {
        writeThinking(block.thinking);
      }
    } else {
      unhandled.push(block);
    }
  }
  process.stdout.write("\n");
  reportTurnOutcome(response, opts.args);

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
