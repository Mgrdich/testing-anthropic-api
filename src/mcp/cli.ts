/**
 * Standalone MCP showcase. Run as `bun run mcp --debug` — the section
 * headers are Debug traces (stderr), so without the flag the demo output
 * runs together with no separators.
 *
 * Spawns the bundled stdio server and exercises the Anthropic SDK's MCP
 * helpers natively (no local-Tool adapter, full block fidelity):
 *   1. inventory       — listTools / listPrompts / listResources
 *   2. prompt          — getPrompt → mcpMessages → beta.messages.create
 *   3. resource        — readResource → mcpResourceToContent → XML-tagged turn
 *   4. agentic turn    — mcpTools → beta.messages.toolRunner
 *
 * Output lines are tagged `[app-facing]` / `[model-facing]` /
 * `[user-facing]` by who consumes the content (see `say` below), so a
 * reader can trace each exchange to its surface.
 */
import {
  mcpMessages,
  mcpResourceToContent,
  UnsupportedMCPValueError,
} from "@anthropic-ai/sdk/helpers/beta/mcp";
import type { BetaToolRunContext } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";
import { AnthropicClient, DEFAULT_MODEL, Debug, errMsg } from "@/core/index.ts";
import {
  connectLocalMcp,
  mcpRunnableTools,
  resourceBlockText,
} from "@/mcp/index.ts";

function betaText(content: BetaMessage["content"]) {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Every demo line is tagged by who consumes the content, so a reader can
 * follow which of the three surfaces each exchange belongs to:
 *   app-facing   — MCP JSON-RPC between this process and the spawned server
 *   model-facing — content that enters (or comes back from) Claude's context
 *   user-facing  — narration and final answers, for the human reader
 */
type Facing = "app" | "model" | "user";

function say(facing: Facing, text: string) {
  process.stdout.write(`[${facing}-facing] ${text}\n`);
}

if (process.argv.includes("--debug")) Debug.get().enable();
const dbg = Debug.get();

const mcp = await connectLocalMcp().catch((err) => {
  process.stderr.write(`error: failed to start MCP server: ${errMsg(err)}\n`);
  process.exit(1);
});

try {
  const { client } = mcp;
  const anthropic = AnthropicClient.get();

  process.stdout.write(
    "each line is tagged by who consumes the content:\n" +
      "  [app-facing]   MCP JSON-RPC between this process and the spawned server\n" +
      "  [model-facing] content that enters (or comes back from) Claude's context\n" +
      "  [user-facing]  narration and final answers, for you\n",
  );

  dbg.section("server");
  const info = client.getServerVersion();
  say("app", `connected to ${info?.name} v${info?.version} (stdio handshake)`);

  dbg.section("inventory");
  const [toolList, promptList, resourceList] = await Promise.all([
    client.listTools(),
    client.listPrompts(),
    client.listResources(),
  ]);
  say("app", `tools:     ${toolList.tools.map((t) => t.name).join(", ")}`);
  say("app", `prompts:   ${promptList.prompts.map((p) => p.name).join(", ")}`);
  say(
    "app",
    `resources: ${resourceList.resources.map((r) => r.uri).join(", ")}`,
  );

  dbg.section("prompt → mcpMessages → Claude");
  try {
    const prompt = await client.getPrompt({
      name: "explain_topic",
      arguments: {
        topic: "the Model Context Protocol",
        audience: "a TypeScript developer",
      },
    });
    const messages = mcpMessages(prompt.messages);
    const firstText = messages[0]?.content;
    if (Array.isArray(firstText)) {
      const head = firstText[0];
      if (head?.type === "text") {
        say("model", `prompt sent to Claude:\n${head.text}\n`);
      }
    }
    const reply = await anthropic.beta.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 512,
      messages,
    });
    say("user", `Claude: ${betaText(reply.content)}`);
  } catch (err) {
    if (err instanceof UnsupportedMCPValueError) {
      process.stderr.write(
        `prompt content not convertible for Claude: ${err.message}\n`,
      );
    } else {
      throw err;
    }
  }
  dbg.section("resource → mcpResourceToContent → Claude (XML-tagged)");
  const firstDoc = resourceList.resources[0];
  if (!firstDoc) {
    say(
      "user",
      "docs/ is empty — generate it via the rag walkthrough; skipping the resource demo",
    );
  } else {
    const doc = await client.readResource({ uri: firstDoc.uri });
    const docBlock = mcpResourceToContent(doc);
    const docText = resourceBlockText(docBlock) ?? `[${docBlock.type}]`;
    const taggedTurn = [
      `<resource uri="${firstDoc.uri}">`,
      docText,
      "</resource>",
      "<question>Summarize this resource in one sentence.</question>",
    ].join("\n");
    say("app", `read one item: ${firstDoc.uri} (${docText.length} chars)`);
    say(
      "model",
      `turn sent to Claude (XML-tagged, ${taggedTurn.length} chars):\n` +
        `${taggedTurn.slice(0, 200)}…\n`,
    );
    const summary = await anthropic.beta.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: taggedTurn }],
    });
    say("user", `Claude: ${betaText(summary.content)}`);
  }

  dbg.section("tools → mcpTools → toolRunner");
  say(
    "model",
    `tool schemas sent to Claude: ${toolList.tools.map((t) => t.name).join(", ")}`,
  );
  const runnable = mcpRunnableTools(toolList.tools, client).map((t) => ({
    ...t,
    run: async (args: Record<string, unknown>, ctx?: BetaToolRunContext) => {
      // Both halves are model-facing: the input is what Claude emitted in
      // its tool_use block, and the result is fed back into its context.
      process.stderr.write(
        `\n\n[model-facing] [tool] ${t.name}(${JSON.stringify(ctx?.toolUse.input ?? args)})\n`,
      );
      const out = await t.run(args, ctx);
      process.stderr.write(
        `  → ${typeof out === "string" ? out : JSON.stringify(out)}\n`,
      );
      return out;
    },
  }));
  const runner = anthropic.beta.messages.toolRunner({
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: true,
    tools: runnable,
    messages: [
      {
        role: "user",
        content:
          "List the available project docs, read the most interesting one, and summarize in two sentences what it covers.",
      },
    ],
  });
  process.stdout.write("[user-facing] Claude: ");
  for await (const stream of runner) {
    stream.on("text", (delta) => process.stdout.write(delta));
    await stream.finalMessage();
  }
  process.stdout.write("\n");
} finally {
  await mcp.close();
}
