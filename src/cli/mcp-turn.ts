import { errMsg, type MessageParam } from "@/core/index.ts";
import {
  getPromptMessages,
  listMcpPrompts,
  type McpConnection,
  readResourceBlock,
  resourceBlockText,
} from "@/mcp/index.ts";

/**
 * Sigils that route a REPL line to MCP turn construction. `#` invokes a
 * server prompt, `@` mentions a resource. Both are single, regex-safe
 * characters; `/` is intentionally left free for future REPL commands.
 * Change them here — every behavioral and user-facing string derives from
 * these.
 */
export const PROMPT_PREFIX = "#";
export const MENTION_PREFIX = "@";

/** Parse `key=value key="multi word"` pairs from a prompt-command tail. */
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
 * Handle a `#...` line as an MCP prompt invocation, across every connected
 * server. `#prompts` (or `#help`) lists what each live server offers (labelled
 * by server name); `#<name> key=value …` finds the first live server that
 * exposes that prompt, fetches it, and appends its (already XML-tagged)
 * messages to the history. Returns true when a turn was queued and the caller
 * should proceed to the API request.
 *
 * `#` is the prompt prefix; `/` is left free for future REPL commands.
 */
export async function handleMcpPrompt(
  mcps: McpConnection[],
  text: string,
  messages: MessageParam[],
) {
  const space = text.indexOf(" ");
  const body = space === -1 ? text : text.slice(0, space);
  const name = body.slice(PROMPT_PREFIX.length).trim();
  const rest = space === -1 ? "" : text.slice(space + 1).trim();

  const live = mcps.filter((m) => m.alive);
  if (live.length === 0) {
    process.stderr.write("error: no MCP server is running\n");
    return false;
  }
  // Only servers that advertise the prompts capability answer listPrompts;
  // calling it on others is a JSON-RPC "method not found".
  const promptServers = live.filter(
    (m) => m.client.getServerCapabilities()?.prompts !== undefined,
  );

  try {
    if (name === "prompts" || name === "help" || name === "") {
      process.stderr.write(
        `MCP prompts (invoke with ${PROMPT_PREFIX}<name> key=value …):\n`,
      );
      for (const conn of promptServers) {
        const prompts = await listMcpPrompts(conn.client);
        for (const p of prompts) {
          const argList = p.args.map((a) => `${a}=…`).join(" ");
          const desc = p.description ? ` — ${p.description}` : "";
          process.stderr.write(
            `  ${PROMPT_PREFIX}${p.name} ${argList} [${conn.name}]${desc}\n`,
          );
        }
      }
      return false;
    }

    // Find the first live server that exposes a prompt with this name.
    let owner: McpConnection | undefined;
    for (const conn of promptServers) {
      const prompts = await listMcpPrompts(conn.client);
      if (prompts.some((p) => p.name === name)) {
        owner = conn;
        break;
      }
    }
    if (!owner) {
      process.stderr.write(
        `error: no MCP server exposes prompt '${PROMPT_PREFIX}${name}'\n`,
      );
      return false;
    }

    const promptMessages = await getPromptMessages(
      owner.client,
      name,
      parsePromptArgs(rest),
    );
    if (promptMessages.length === 0) {
      process.stderr.write(
        `error: MCP prompt '${PROMPT_PREFIX}${name}' returned no messages\n`,
      );
      return false;
    }
    messages.push(...promptMessages);
    return true;
  } catch (err) {
    process.stderr.write(
      `error: MCP prompt '${PROMPT_PREFIX}${name}' failed: ${errMsg(err)}\n`,
    );
    return false;
  }
}

// Either a full URI (docs://path/to/doc.md) or a bare name/path. The bare
// form allows dotted extensions but must end on an alphanumeric run after
// the dot, so a sentence-final "@doc.md." captures "doc.md" without the
// trailing period. Built from MENTION_PREFIX (a regex-safe single char) so
// the sigil stays a single source of truth.
const MENTION_RE = new RegExp(
  `${MENTION_PREFIX}([A-Za-z0-9_-]+://[^\\s]+|[A-Za-z0-9/_-]+(?:\\.[A-Za-z0-9]+)*)`,
  "g",
);

/**
 * Build the user-turn content for a line that may carry `@resource`
 * mentions. Each mention is resolved against every live server in turn (the
 * first that has it wins) and sent as its own content block, wrapped in XML
 * tags (matching the rag prompt style); the user's text follows as the final
 * block. Unresolvable mentions warn and stay literal. Lines without mentions
 * pass through as plain text.
 */
export async function buildMentionContent(mcps: McpConnection[], text: string) {
  const refs = [
    ...new Set(
      [...text.matchAll(MENTION_RE)]
        .map((m) => m[1])
        .filter((r): r is string => r !== undefined),
    ),
  ];
  if (refs.length === 0) return text;
  // Only servers that advertise the resources capability answer readResource.
  const live = mcps.filter(
    (m) => m.alive && m.client.getServerCapabilities()?.resources !== undefined,
  );
  if (live.length === 0) {
    process.stderr.write(
      "warning: no MCP server with resources is running; sending @mentions as literal text\n",
    );
    return text;
  }

  const blocks: Exclude<MessageParam["content"], string> = [];
  for (const ref of refs) {
    let resolved = false;
    let lastErr: unknown;
    for (const conn of live) {
      try {
        const { uri, block } = await readResourceBlock(conn.client, ref);
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
        process.stderr.write(`[mcp] attached resource ${uri} [${conn.name}]\n`);
        resolved = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!resolved) {
      process.stderr.write(
        `warning: could not fetch MCP resource '${MENTION_PREFIX}${ref}': ${errMsg(lastErr)}\n`,
      );
    }
  }
  if (blocks.length === 0) return text;
  blocks.push({ type: "text", text });
  return blocks;
}
