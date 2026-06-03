import type Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import {
  streamAssistantMessage,
  type MessageParam,
  type StreamAssistantOptions,
} from "@/core/messages.ts";
import { errMsg } from "@/core/util.ts";
import type { Tool } from "@/core/tools/types.ts";

export type AgenticHooks = {
  onStream?: (stream: MessageStream) => void;
  onRound?: (info: {
    iteration: number;
    stop_reason: Anthropic.Message["stop_reason"];
    tool_use_blocks: number;
  }) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, result: string, isError: boolean) => void;
  // Predicate identifying tools whose execution must be confirmed by the
  // user via `approveMutating`. The mutating set lives outside the Tool
  // type because the SDK's BetaRunnableTool doesn't carry that flag.
  isMutating?: (name: string) => boolean;
  approveMutating?: (name: string, input: unknown) => Promise<boolean>;
};

export type RunAgenticOptions = StreamAssistantOptions & {
  // Cap on API iterations. Each iteration is one assistant response + one
  // round of tool execution. If unset, the loop runs until the model emits
  // a non-`tool_use` stop_reason. When the cap is hit, the function returns
  // the last assistant response (which will still have stop_reason="tool_use",
  // letting the caller detect that the cap fired).
  max_iterations?: number;
};

export async function runAgenticTurn(
  messages: MessageParam[],
  opts: RunAgenticOptions,
  tools: readonly Tool[],
  hooks: AgenticHooks = {},
) {
  const { max_iterations, ...apiOpts } = opts;

  // Wire boundary: our Tool carries the beta input_schema type (the SDK's
  // betaZodTool produces it), but we send via the non-beta messages API.
  // The JSON shape is identical — only the TS `required: readonly string[]`
  // variant differs — so a type assertion is safe.
  const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  let iteration = 0;
  while (true) {
    iteration++;
    const response = await streamAssistantMessage(
      messages,
      { ...apiOpts, tools: toolDefs },
      hooks.onStream,
    );

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    hooks.onRound?.({
      iteration,
      stop_reason: response.stop_reason,
      tool_use_blocks: toolUseBlocks.length,
    });

    if (response.stop_reason !== "tool_use") return response;
    if (max_iterations !== undefined && iteration >= max_iterations) {
      // Cap reached. Return without dispatching tools (the next iteration
      // would make a second API call we're trying to avoid). The returned
      // message still carries stop_reason="tool_use".
      return response;
    }

    // Phase 1: serial approval pass. Approval prompts (y/N readline) cannot
    // interleave concurrently, so they happen before any tool runs.
    type PreparedCall = {
      block: Anthropic.ToolUseBlock;
      tool: Tool | undefined;
      approved: boolean;
    };
    const prepared: PreparedCall[] = [];
    for (const block of toolUseBlocks) {
      hooks.onToolCall?.(block.name, block.input);
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
