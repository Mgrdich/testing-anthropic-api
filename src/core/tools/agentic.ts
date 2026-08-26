import type Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { Debug } from "@/core/debug.ts";
import {
  type MessageParam,
  type StreamAssistantOptions,
  streamAssistantMessage,
} from "@/core/messages.ts";
import { isAnthropicDefinedTool, type Tool } from "@/core/tools/types.ts";
import { errMsg } from "@/core/util.ts";

export type AgenticHooks = {
  onStream?: (stream: MessageStream) => void;
  onRound?: (info: {
    iteration: number;
    stop_reason: Anthropic.Message["stop_reason"];
    tool_use_blocks: number;
  }) => void;
  // `caller` is the tool_use block's caller discriminator: "direct" for a
  // normal model-issued call, or the code-execution tool type when the call
  // came from a PTC script running in the container. Only the local runner
  // supplies it (the SDK runner has no per-call block to read it from).
  onToolCall?: (name: string, input: unknown, caller?: string) => void;
  onToolResult?: (name: string, result: string, isError: boolean) => void;
  // Predicate identifying tools whose execution must be confirmed by the
  // user via `approveMutating`. The mutating set lives outside the Tool
  // type because the SDK's BetaRunnableTool doesn't carry that flag.
  isMutating?: (name: string) => boolean;
  approveMutating?: (name: string, input: unknown) => Promise<boolean>;
};

/** One member of a tool def's `allowed_callers` list. */
export type ToolCaller = NonNullable<Anthropic.Tool["allowed_callers"]>[number];

/** Wire type of the code-execution tool that hosts programmatic tool calling. */
export const PTC_TOOL_TYPE = "code_execution_20260120";

/**
 * The Anthropic-hosted tool entry that turns on **programmatic tool calling**:
 * Claude writes a script in the code-execution container and the container
 * calls our tools as functions, so intermediate results never enter the
 * model's context. Goes out in `server_tools` — the API owns both its schema
 * and its execution, so there is no local executor and it is not a `Tool`.
 */
export const PTC_CODE_EXECUTION_TOOL = {
  type: PTC_TOOL_TYPE,
  name: "code_execution",
} as const satisfies Anthropic.ToolUnion;

/**
 * Default ceiling on consecutive `pause_turn` resumes (see
 * `max_pause_resumes`). Unlike `max_iterations` this defaults to a finite
 * value: an unbounded pause loop is never a legitimate run.
 */
const DEFAULT_MAX_PAUSE_RESUMES = 5;

const dbg = Debug.get();

export type RunAgenticOptions = StreamAssistantOptions & {
  // Cap on API iterations. Each iteration is one assistant response + one
  // round of tool execution (or one `pause_turn` resume). If unset, the loop
  // runs until the model emits a terminal stop_reason. When the cap is hit,
  // the function returns the last assistant response (which will still have
  // stop_reason="tool_use"/"pause_turn", letting the caller detect that the
  // cap fired).
  max_iterations?: number;
  /**
   * Cap on *consecutive* `pause_turn` resumes, applied even when
   * `max_iterations` is unset. A tool_use round always makes local progress
   * (a tool runs, a result is pushed); a pause resume makes none — it just
   * re-sends the conversation — so a server-side loop stuck on `pause_turn`
   * would otherwise bill an unbounded stream of API calls with nothing to
   * show for them. Reset whenever a round does anything else.
   */
  max_pause_resumes?: number;
  /**
   * Anthropic-hosted tool definitions appended verbatim to the wire `tools`
   * array, next to the client-side `tools` argument. They carry no executor —
   * the API runs them — so they never appear in `toolByName`.
   * `PTC_CODE_EXECUTION_TOOL` is the one shipped today.
   */
  server_tools?: readonly Anthropic.ToolUnion[];
  /**
   * Stamped onto every client-side tool def. Programmatic tool calling sets
   * `[PTC_TOOL_TYPE]` so the model may only reach these tools from inside the
   * code-execution container. Unset = the API default (`["direct"]`).
   */
  allowed_callers?: readonly ToolCaller[];
  /**
   * Drop `strict` from the custom-tool projection. `defineTool` turns strict
   * tool use on for every built-in, and the API rejects strict tools when
   * programmatic tool calling is enabled — so the PTC path omits it.
   */
  omit_strict?: boolean;
};

export async function runAgenticTurn(
  messages: MessageParam[],
  opts: RunAgenticOptions,
  tools: readonly Tool[],
  hooks: AgenticHooks = {},
) {
  const {
    max_iterations,
    max_pause_resumes = DEFAULT_MAX_PAUSE_RESUMES,
    server_tools,
    allowed_callers,
    omit_strict,
    ...apiOpts
  } = opts;

  // Wire boundary. Two projections, one per Tool flavor, plus the
  // Anthropic-hosted `server_tools` appended verbatim:
  //
  // - Anthropic-defined tools (memory) go out as `{type, name}`. The model
  //   owns their schema, so there is nothing else to send. The cast is
  //   because `Anthropic.ToolUnion`'s members pin `name` to a literal per
  //   `type` (`name: "memory"` for `memory_20250818`), which a
  //   `{type: string, name: string}` pair can't satisfy structurally.
  // - Custom tools carry the beta `input_schema` type (the SDK's
  //   betaZodTool produces it) but we send via the non-beta messages API.
  //   The JSON shape is identical — only the TS `required: readonly
  //   string[]` variant differs — so a type assertion is safe. `strict` is
  //   forwarded so `defineTool`'s strict tool use survives the projection,
  //   unless `omit_strict` drops it (strict is incompatible with PTC).
  //
  // `allowed_callers` is stamped onto both client-side flavors, never onto
  // the server tool that hosts them.
  const callers =
    allowed_callers === undefined
      ? {}
      : { allowed_callers: [...allowed_callers] };
  const toolDefs: Anthropic.ToolUnion[] = [
    ...tools.map((t) =>
      isAnthropicDefinedTool(t)
        ? ({
            type: t.type,
            name: t.name,
            ...callers,
          } as unknown as Anthropic.ToolUnion)
        : {
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool.InputSchema,
            ...(t.strict === undefined || omit_strict
              ? {}
              : { strict: t.strict }),
            ...callers,
          },
    ),
    ...(server_tools ?? []),
  ];
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // The wire projection is where strict / allowed_callers / server_tools
  // actually land, and all three are invisible in the `[tool]` traces — so
  // trace the shapes once, before the first round.
  dbg.json("tool defs", () =>
    toolDefs.map((t) => ({
      name: "name" in t ? t.name : undefined,
      type: "type" in t ? t.type : "custom",
      strict: "strict" in t ? t.strict : undefined,
      allowed_callers: "allowed_callers" in t ? t.allowed_callers : undefined,
    })),
  );

  // Container id for the code-execution sandbox behind programmatic tool
  // calling. The API mints one on the first round that runs code and returns
  // it on every response; echoing it back on later rounds keeps the same
  // container (and its REPL state) for the rest of the turn.
  let container: string | undefined;

  let iteration = 0;
  let pauseResumes = 0;
  while (true) {
    iteration++;
    const response = await streamAssistantMessage(
      messages,
      {
        ...apiOpts,
        tools: toolDefs,
        ...(container === undefined ? {} : { container }),
      },
      hooks.onStream,
    );
    const priorContainer = container;
    container = response.container?.id ?? container;
    // Container identity is the whole point of PTC's REPL persistence, and
    // nothing else surfaces it — trace when one is minted or swapped.
    if (container !== priorContainer) {
      dbg.log(
        () =>
          `container ${priorContainer === undefined ? "minted" : "changed"}: ${container}`,
      );
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    hooks.onRound?.({
      iteration,
      stop_reason: response.stop_reason,
      tool_use_blocks: toolUseBlocks.length,
    });

    // `pause_turn` means the API's own server-side loop (code execution)
    // paused a long-running turn — not that it wants anything from us. The
    // assistant turn is already in `messages` (streamAssistantMessage pushed
    // it), so resuming is just re-sending the conversation as-is: no user
    // message, no tool dispatch. Anything else terminal ends the turn.
    const resumable =
      response.stop_reason === "tool_use" ||
      response.stop_reason === "pause_turn";
    if (!resumable) return response;
    if (max_iterations !== undefined && iteration >= max_iterations) {
      // Cap reached. Return without dispatching tools (the next iteration
      // would make a second API call we're trying to avoid). The returned
      // message still carries stop_reason="tool_use"/"pause_turn".
      return response;
    }
    if (response.stop_reason === "pause_turn") {
      // A resume makes no local progress, so a pathological pause loop would
      // bill an unbounded stream of API calls. Bail with the paused message,
      // which the caller already treats as "the turn didn't finish".
      if (++pauseResumes > max_pause_resumes) {
        dbg.log(
          () =>
            `pause_turn cap reached (${max_pause_resumes} consecutive resumes); returning paused message`,
        );
        return response;
      }
      dbg.log(() => `pause_turn resume ${pauseResumes}/${max_pause_resumes}`);
      continue;
    }
    pauseResumes = 0;

    // Phase 1: serial approval pass. Approval prompts (y/N readline) cannot
    // interleave concurrently, so they happen before any tool runs.
    type PreparedCall = {
      block: Anthropic.ToolUseBlock;
      tool: Tool | undefined;
      approved: boolean;
    };
    const prepared: PreparedCall[] = [];
    for (const block of toolUseBlocks) {
      hooks.onToolCall?.(block.name, block.input, block.caller?.type);
      const tool = toolByName.get(block.name);
      let approved = true;
      if (tool && hooks.isMutating?.(block.name) && hooks.approveMutating) {
        approved = await hooks.approveMutating(block.name, block.input);
      }
      prepared.push({ block, tool, approved });
    }

    // Phase 2: parallel execution. Promise.all preserves array order so the
    // resultBlocks line up with the model's tool_use block order.
    const resultBlocks = await Promise.all(
      prepared.map(async ({ block, tool, approved }) => {
        const { content, isError } = !approved
          ? {
              content: "user denied execution of this tool call",
              isError: true,
            }
          : await executeToolCall(block, tool);
        hooks.onToolResult?.(block.name, content, isError);
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content,
          ...(isError ? { is_error: true } : {}),
        };
      }),
    );

    messages.push({ role: "user", content: resultBlocks });
  }
}

async function executeToolCall(
  block: Anthropic.ToolUseBlock,
  tool: Tool | undefined,
) {
  if (!tool) {
    return { content: `unknown tool: ${block.name}`, isError: true };
  }
  try {
    // betaZodTool separates parse (validate the model's raw input against
    // the Zod schema) from run (execute on the validated value). Match the
    // SDK's own runRunnableTool: parse → run → catch.
    const parsed = tool.parse ? tool.parse(block.input) : block.input;
    const result = await tool.run(parsed);
    return {
      content: typeof result === "string" ? result : JSON.stringify(result),
      isError: false,
    };
  } catch (err) {
    return { content: errMsg(err), isError: true };
  }
}
