import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createMemoryHandlers, DEFAULT_MEMORY_DIR } from "@/core/index.ts";
import { errMsg } from "@/core/util.ts";

/**
 * The memory tool, rebuilt as an ordinary custom tool.
 *
 * `bun run dev --memory` uses the **Anthropic-defined** tool
 * (`memory_20250818`), whose schema the model already knows. That tool type has
 * no Agent SDK expression — the SDK only speaks MCP tools — so here the same
 * six commands are exposed under a hand-written schema instead.
 *
 * What is reused verbatim: `createMemoryHandlers(dir)`, and with it
 * `resolveMemoryPath` and the whole containment boundary. The security
 * properties are identical; only the schema the model sees is ours rather than
 * Anthropic's, which means tool-selection quality now depends on the
 * description below.
 */
export const memoryShape = {
  command: z
    .enum(["view", "create", "str_replace", "insert", "delete", "rename"])
    .describe("Which memory operation to perform."),
  path: z
    .string()
    .optional()
    .describe(
      "Target path under the /memories root, e.g. '/memories/notes.md'. Required for every command except rename.",
    ),
  file_text: z
    .string()
    .optional()
    .describe("Full file contents. Required for 'create'."),
  old_str: z
    .string()
    .optional()
    .describe(
      "Exact text to replace; must appear exactly once. Required for 'str_replace'.",
    ),
  new_str: z
    .string()
    .optional()
    .describe("Replacement text. Required for 'str_replace'."),
  insert_line: z
    .number()
    .int()
    .optional()
    .describe(
      "0-based line index to insert after (0 = start of file). Required for 'insert'.",
    ),
  insert_text: z
    .string()
    .optional()
    .describe("Line of text to insert. Required for 'insert'."),
  old_path: z
    .string()
    .optional()
    .describe("Existing path. Required for 'rename'."),
  new_path: z
    .string()
    .optional()
    .describe("Destination path. Required for 'rename'."),
  view_range: z
    .array(z.number().int())
    .optional()
    .describe(
      "Optional [start, end] 1-based line clip for 'view'; end -1 means through the last line.",
    ),
};

/** Narrow an optional field to a required one, with the model-facing error. */
function req<T>(value: T | undefined, field: string, command: string): T {
  if (value === undefined) {
    throw new Error(`'${field}' is required for command '${command}'`);
  }
  return value;
}

export function memoryTool(dir: string = DEFAULT_MEMORY_DIR) {
  const handlers = createMemoryHandlers(dir);

  return tool(
    "memory",
    "Persistent notes stored under a /memories directory that survive across sessions. Use 'view' to read a file or list a directory, 'create' to write a whole file, 'str_replace' or 'insert' to edit one, and 'delete'/'rename' to manage them. Consult it before answering questions about the user's preferences or prior work, and record durable facts as you learn them.",
    memoryShape,
    async (args) => {
      try {
        // Every branch reconstructs the SDK's command object so the shared
        // handlers — and their containment checks — run unchanged.
        const result = await (async () => {
          switch (args.command) {
            case "view":
              return handlers.view({
                command: "view",
                path: req(args.path, "path", "view"),
                ...(args.view_range ? { view_range: args.view_range } : {}),
              });
            case "create":
              return handlers.create({
                command: "create",
                path: req(args.path, "path", "create"),
                file_text: req(args.file_text, "file_text", "create"),
              });
            case "str_replace":
              return handlers.str_replace({
                command: "str_replace",
                path: req(args.path, "path", "str_replace"),
                old_str: req(args.old_str, "old_str", "str_replace"),
                new_str: req(args.new_str, "new_str", "str_replace"),
              });
            case "insert":
              return handlers.insert({
                command: "insert",
                path: req(args.path, "path", "insert"),
                insert_line: req(args.insert_line, "insert_line", "insert"),
                insert_text: req(args.insert_text, "insert_text", "insert"),
              });
            case "delete":
              return handlers.delete({
                command: "delete",
                path: req(args.path, "path", "delete"),
              });
            case "rename":
              return handlers.rename({
                command: "rename",
                old_path: req(args.old_path, "old_path", "rename"),
                new_path: req(args.new_path, "new_path", "rename"),
              });
          }
        })();
        const text =
          typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        // Mirror `executeToolCall`: a tool failure is an error *result* the
        // model can react to, never a thrown turn.
        return {
          content: [{ type: "text" as const, text: errMsg(err) }],
          isError: true,
        };
      }
    },
    // Tool search defers SDK MCP tool schemas by default; this one is central
    // to the demo, so keep it in the initial prompt.
    { alwaysLoad: true, annotations: { readOnlyHint: false } },
  );
}
