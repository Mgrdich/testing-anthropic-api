import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentArgs } from "@/agent/args.ts";
import { unqualify } from "@/agent/tools/builtins.ts";
import { Debug } from "@/core/index.ts";

// ANSI only when stderr is a TTY, so redirected diagnostics carry no escapes.
const DIM = process.stderr.isTTY ? "\x1b[2m" : "";
const RESET = process.stderr.isTTY ? "\x1b[0m" : "";

const TOOL_RESULT_PREVIEW_MAX = 200;

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Flatten a `tool_result` block's content for the `→` trace.
 *
 * MCP tools return an array of content blocks rather than a bare string, so
 * printing it raw would show `[{"type":"text","text":"20"}]` where
 * `bun run dev` shows `20`. Text blocks are joined; anything else degrades to
 * a `[type]` placeholder rather than dumping base64 image data into the trace.
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return compactJson(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "type" in block) {
        const typed = block as { type: string; text?: string };
        return typed.type === "text" && typeof typed.text === "string"
          ? typed.text
          : `[${typed.type}]`;
      }
      return compactJson(block);
    })
    .join("\n");
}

/**
 * Renders the `SDKMessage` stream to the terminal. This single function
 * replaces the whole `AgenticHooks` surface from `bun run dev` — `onStream`,
 * `onRound`, `onToolCall`, `onToolResult` — plus `reportTurnOutcome`.
 *
 * **Output discipline** (same rule as `src/cli/`): stdout carries model text
 * and nothing else; every diagnostic goes to stderr. The `SDKMessage` union
 * has ~38 variants, so it is easy to leak — the `default` branch counts
 * anything unhandled instead of silently dropping it.
 */
export function createRenderer(args: AgentArgs) {
  const dbg = Debug.get();
  let inThinking = false;
  let wroteText = false;
  const unknownTypes = new Set<string>();

  function closeThinking() {
    if (inThinking) {
      process.stderr.write(`${RESET}\n`);
      inThinking = false;
    }
  }

  function handle(m: SDKMessage) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          dbg.json("session init", () => ({
            session_id: m.session_id,
            model: m.model,
            permissionMode: m.permissionMode,
            apiKeySource: m.apiKeySource,
            tools: m.tools,
            mcp_servers: m.mcp_servers,
          }));
        }
        return;

      case "stream_event": {
        // The only stdout writer. Text and thinking arrive as raw Messages API
        // stream events because `includePartialMessages` is always on.
        const e = m.event;
        if (e.type === "content_block_delta") {
          if (e.delta.type === "text_delta") {
            closeThinking();
            wroteText = true;
            process.stdout.write(e.delta.text);
          } else if (e.delta.type === "thinking_delta") {
            if (!inThinking) {
              process.stderr.write(`${DIM}[thinking] `);
              inThinking = true;
            }
            process.stderr.write(e.delta.thinking);
          }
        } else if (e.type === "content_block_stop") {
          closeThinking();
        }
        return;
      }

      case "assistant": {
        // Text blocks are deliberately NOT printed here. With
        // includePartialMessages on they already went out as deltas, and the
        // CLI emits one assistant message per completed content block — so
        // printing them too would double every token.
        for (const block of m.message.content) {
          if (block.type === "tool_use") {
            if (wroteText) {
              process.stdout.write("\n");
              wroteText = false;
            }
            process.stderr.write(
              `[tool] ${unqualify(block.name)}(${compactJson(block.input)})\n`,
            );
          }
        }
        if (m.error) {
          process.stderr.write(`warning: assistant error (${m.error})\n`);
        }
        return;
      }

      case "user": {
        // Tool results come back as a synthetic user turn.
        const content = m.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const text = toolResultText(block.content);
          const shown =
            dbg.enabled || text.length <= TOOL_RESULT_PREVIEW_MAX
              ? text
              : `${text.slice(0, TOOL_RESULT_PREVIEW_MAX)}…`;
          process.stderr.write(`  ${block.is_error ? "✗" : "→"} ${shown}\n`);
        }
        return;
      }

      case "result": {
        closeThinking();
        process.stdout.write("\n");
        wroteText = false;
        dbg.json("result", m);

        // `stop_reason` survives as a plain string; `stop_details.category` /
        // `.explanation` have no Agent SDK equivalent, so the refusal line is
        // less informative than the one in `src/cli/repl.ts`.
        if (m.stop_reason === "refusal") {
          process.stderr.write("refusal: model declined to answer\n");
        }
        if (m.subtype !== "success") {
          process.stderr.write(
            `warning: turn ended as ${m.subtype}${
              m.errors.length > 0 ? `: ${m.errors.join("; ")}` : ""
            }\n`,
          );
        }
        if (args.cache) {
          // Placement is the SDK's business now; only observability survives.
          // `modelUsage` is the correct field — `usage` excludes subagents —
          // and it is CUMULATIVE across turns in a streaming-input session.
          for (const [model, u] of Object.entries(m.modelUsage)) {
            process.stderr.write(
              `[cache] ${model} read=${u.cacheReadInputTokens} wrote=${u.cacheCreationInputTokens} uncached=${u.inputTokens} cost=$${u.costUSD.toFixed(4)} (cumulative)\n`,
            );
          }
        }
        return;
      }

      default: {
        // The union grows between SDK versions; warn once per unseen type
        // under --debug rather than dropping it silently.
        if (!unknownTypes.has(m.type)) {
          unknownTypes.add(m.type);
          dbg.log(() => `unhandled SDKMessage type: ${m.type}`);
        }
      }
    }
  }

  return { handle };
}
