import type Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { BetaToolRunContext } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/ToolRunner";
import type {
  BetaMessage,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta";
import { AnthropicClient } from "@/core/client.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";
import type { MessageParam } from "@/core/messages.ts";
import type { AgenticHooks, RunAgenticOptions } from "@/core/tools/agentic.ts";
import type { Tool } from "@/core/tools/types.ts";

/**
 * Alternative agentic loop backed by `client.beta.messages.toolRunner()` from
 * the official SDK. Same signature and behavior contract as `runAgenticTurn`
 * (returns the final assistant message, mutates `messages` to reflect the
 * full conversation history) so the REPL can swap implementations with one
 * function-reference branch.
 *
 * Divergences from `runAgenticTurn` (documented in tools/CLAUDE.md):
 * - Tool dispatch is fully parallel via the SDK's `Promise.all`; `onToolCall`
 *   / `onToolResult` / `approveMutating` are emitted from wrappers around
 *   each tool's `run`, so when multiple mutating tools fire in one round
 *   their approval prompts race rather than serialize. (No mutating tools
 *   ship today; revisit when they do.)
 * - `messages` is structurally cloned on entry to the runner; after the loop
 *   we replace the caller's array contents with the runner's final state.
 */
export async function runAgenticTurnSdk(
  messages: MessageParam[],
  opts: RunAgenticOptions,
  tools: readonly Tool[],
  hooks: AgenticHooks = {},
) {
  const { max_iterations, ...apiOpts } = opts;

  // Wrap each tool to emit hooks + gate mutating calls. The SDK's
  // `runRunnableTool` calls run(parsed, ctx) directly — no built-in event
  // hooks — so we have to inject the events here.
  const wrapped = tools.map((t) => ({
    ...t,
    run: async (args: unknown, ctx?: BetaToolRunContext) => {
      const rawInput = ctx?.toolUse.input;
      hooks.onToolCall?.(t.name, rawInput);
      if (hooks.isMutating?.(t.name) && hooks.approveMutating) {
        const approved = await hooks.approveMutating(t.name, rawInput);
        if (!approved) {
          const msg = "user denied execution of this tool call";
          hooks.onToolResult?.(t.name, msg, true);
          throw new Error(msg);
        }
      }
      try {
        const out = await t.run(args);
        const content = typeof out === "string" ? out : JSON.stringify(out);
        hooks.onToolResult?.(t.name, content, false);
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        hooks.onToolResult?.(t.name, msg, true);
        throw err;
      }
    },
  }));

  const client = AnthropicClient.get();

  // Wire-side cast: our apiOpts comes from `StreamAssistantOptions` (non-beta
  // MessageStreamParams) which has subtly different shapes for a few optional
  // fields (output_config, etc.) than the beta request body. The runtime JSON
  // for the keys we actually set (model, max_tokens, system, temperature,
  // stop_sequences) is identical. We cast the assembled body once at the
  // call site. Defaults for model / max_tokens are applied here because the
  // beta body requires them as non-optional; our `runAgenticTurn` gets them
  // implicitly via `streamAssistantMessage`.
  const body = {
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...apiOpts,
    stream: true,
    messages,
    tools: wrapped,
    ...(max_iterations !== undefined ? { max_iterations } : {}),
  } as unknown as BetaToolRunnerParams & { stream: true };
  const runner = client.beta.messages.toolRunner(body);

  let iteration = 0;
  let lastFinal: BetaMessage | undefined;
  for await (const stream of runner) {
    iteration++;
    hooks.onStream?.(stream as unknown as MessageStream);
    lastFinal = await stream.finalMessage();
    const toolUseBlocks = lastFinal.content.filter(
      (b): b is BetaToolUseBlock => b.type === "tool_use",
    );
    hooks.onRound?.({
      iteration,
      // BetaStopReason includes "compaction" which isn't in non-beta
      // StopReason. The values we care about ("tool_use", "end_turn",
      // "max_tokens", "stop_sequence") exist in both; cast to widen.
      stop_reason: lastFinal.stop_reason as Anthropic.Message["stop_reason"],
      tool_use_blocks: toolUseBlocks.length,
    });
  }
  if (!lastFinal) {
    throw new Error("toolRunner produced no messages");
  }

  // Sync the runner's mutated history back into the caller's array. The
  // runner deep-clones params.messages in its constructor, so without this
  // the caller's array would only have the original user turn. One cast at
  // the array boundary since runner.params.messages is BetaMessageParam[].
  messages.length = 0;
  messages.push(...(runner.params.messages as unknown as MessageParam[]));

  return lastFinal;
}
