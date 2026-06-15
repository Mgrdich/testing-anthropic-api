import { errMsg, type MessageParam } from "@/core/index.ts";
import {
  getPromptMessages,
  listMcpPrompts,
  readResourceBlock,
  resourceBlockText,
  type McpConnection,
} from "@/mcp/index.ts";

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
export async function handleMcpSlash(
  mcp: McpConnection,
  text: string,
  messages: MessageParam[],
) {
  const space = text.indexOf(" ");
  const name = (space === -1 ? text.slice(1) : text.slice(1, space)).trim();
  const rest = space === -1 ? "" : text.slice(space + 1).trim();

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
    messages.push(...promptMessages);
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
export async function buildMentionContent(
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
