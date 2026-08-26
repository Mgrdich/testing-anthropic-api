import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type {
  BetaAdvisorTool20260301,
  BetaMessage,
} from "@anthropic-ai/sdk/resources/beta";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { AnthropicClient } from "@/core/client.ts";
import {
  ADVISOR_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
} from "@/core/constants.ts";
import { Debug } from "@/core/debug.ts";
import type { MessageParam, StreamAssistantOptions } from "@/core/messages.ts";

/** Beta header the advisor tool ships behind. */
export const ADVISOR_BETA = "advisor-tool-2026-03-01";

/**
 * The stream `client.beta.messages.stream()` hands back for an advisor
 * request. `ParsedT` is `unknown` because the request carries no
 * `output_config` for the SDK to infer a parsed shape from.
 */
export type AdvisorStream = BetaMessageStream<unknown>;

export type StreamAdvisorOptions = StreamAssistantOptions & {
  /**
   * Model the advisor tool consults (the tool's own `model` field, distinct
   * from the executor `model` that runs the turn). Defaults to
   * `ADVISOR_MODEL`.
   */
  advisor_model?: string;
};

/**
 * Streaming turn with the **server-side advisor tool** enabled: the executor
 * model can consult a stronger advisor model mid-turn, and the API runs that
 * sub-inference itself — there is no client-side tool loop here, which is why
 * this is a single `stream()` call rather than anything in `core/tools/`.
 *
 * The response content carries the advisor exchange (`server_tool_use` +
 * `advisor_tool_result` blocks) alongside the usual text/thinking blocks, and
 * **the whole content array is pushed to history verbatim**: advisor results
 * (including the opaque `advisor_redacted_result` blob) must be echoed back
 * unmodified on later turns. The tool declaration must also stay in every
 * subsequent request once an advisor block is in history — dropping it 400s.
 * Both hold naturally for the CLI, where `--advisor` is a per-session flag.
 */
export async function streamAdvisorMessage(
  messages: MessageParam[],
  opts: StreamAdvisorOptions = {},
  onStream?: (stream: AdvisorStream) => void,
): Promise<BetaMessage> {
  const { advisor_model, ...apiOpts } = opts;

  const advisor: BetaAdvisorTool20260301 = {
    type: "advisor_20260301",
    name: "advisor",
    model: advisor_model ?? ADVISOR_MODEL,
  };

  // Wire-side cast, same beta ↔ non-beta boundary as `agentic_sdk.ts`:
  // `apiOpts` is typed against the non-beta stream params, whose optional
  // fields differ in shape from the beta body even though the JSON we
  // actually send (model, max_tokens, system, temperature, stop_sequences,
  // thinking, cache_control) is identical.
  const body = {
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...apiOpts,
    messages,
    tools: [advisor],
    betas: [ADVISOR_BETA],
  } as unknown as BetaMessageStreamParams;

  // The executor↔advisor pairing is validated server-side and a bad pair is a
  // flat 400, so trace both models and the beta before sending — otherwise the
  // error names neither.
  Debug.get().json("advisor request", {
    executor: apiOpts.model ?? DEFAULT_MODEL,
    advisor: advisor.model,
    beta: ADVISOR_BETA,
  });

  const stream = AnthropicClient.get().beta.messages.stream(body);
  onStream?.(stream);

  const finalMessage = await stream.finalMessage();
  messages.push({
    role: "assistant",
    content: finalMessage.content as unknown as MessageParam["content"],
  });
  return finalMessage;
}
