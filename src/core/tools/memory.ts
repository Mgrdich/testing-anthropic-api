import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  betaMemoryTool,
  type MemoryToolHandlers,
} from "@anthropic-ai/sdk/helpers/beta/memory";
import { Debug } from "@/core/debug.ts";
import type { Tool } from "@/core/tools/types.ts";

const dbg = Debug.get();

/** Default backing directory for `--memory` (gitignored). */
export const DEFAULT_MEMORY_DIR = "./memories";

/** Wire name/type of the Anthropic-defined memory tool. */
export const MEMORY_TOOL_NAME = "memory";
export const MEMORY_TOOL_TYPE = "memory_20250818";

/**
 * The virtual root the model addresses. The tool's contract is that every
 * path lives under `/memories`; we map that prefix onto the configured
 * backing directory so the model never sees a host path.
 */
const VIRTUAL_ROOT = "memories";

/**
 * Resolve a model-supplied path against the backing directory.
 *
 * Model output is untrusted, so this runs two checks, not one:
 *
 * 1. An **absolute** path must address the virtual root — `/memories` or
 *    `/memories/…`. Anything else (`/etc/passwd`, `/memories-evil/x`) is
 *    rejected outright rather than silently reinterpreted as relative,
 *    which would contain it but hide the mistake from the model.
 * 2. The path is then canonicalized with `path.resolve` and required to be
 *    the root itself or a descendant of it (prefix check *including* the
 *    separator). That is what stops `..` traversal — `/memories/../../etc`
 *    passes check 1 and fails here.
 *
 * Symlinks inside the directory are not resolved through: the sandbox is a
 * demo store, not a multi-tenant boundary (see `tools/CLAUDE.md`).
 */
function resolveMemoryPath(root: string, input: string) {
  let relative = input;
  if (input.startsWith("/")) {
    const trimmed = input.replace(/^\/+/, "");
    if (trimmed !== VIRTUAL_ROOT && !trimmed.startsWith(`${VIRTUAL_ROOT}/`)) {
      throw new Error(
        `memory paths must live under /${VIRTUAL_ROOT} (got ${input})`,
      );
    }
    relative = trimmed.slice(VIRTUAL_ROOT.length).replace(/^\/+/, "");
  }
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`path escapes the memory directory: ${input}`);
  }
  return full;
}

async function statOrNull(target: string) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function readLines(target: string) {
  const text = await fs.readFile(target, "utf8");
  return text.split("\n");
}

async function listDirectory(target: string) {
  const entries = await fs.readdir(target, { withFileTypes: true });
  if (entries.length === 0) return "(empty)";
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join("\n");
}

/**
 * Render a file with 1-based line numbers, optionally clipped to
 * `view_range` (`[start, end]`, `end: -1` meaning "to the last line").
 */
function renderLines(lines: readonly string[], range?: number[]) {
  const start = range?.[0] ?? 1;
  const rawEnd = range?.[1] ?? -1;
  const end = rawEnd === -1 ? lines.length : rawEnd;
  const clampedStart = Math.max(1, start);
  const clampedEnd = Math.min(lines.length, end);
  const out: string[] = [];
  for (let i = clampedStart; i <= clampedEnd; i++) {
    out.push(`${i}\t${lines[i - 1] ?? ""}`);
  }
  return out.join("\n");
}

async function writeFileAt(target: string, contents: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

/**
 * Filesystem backend for the memory tool, shaped as the SDK's
 * `MemoryToolHandlers` so `betaMemoryTool(handlers)` can consume it
 * verbatim. Every handler resolves its path through `resolveMemoryPath`
 * first, so containment is enforced in exactly one place.
 */
export function createMemoryHandlers(
  dir: string = DEFAULT_MEMORY_DIR,
): MemoryToolHandlers {
  const root = path.resolve(dir);
  return {
    async view(command) {
      const target = resolveMemoryPath(root, command.path);
      const stat = await statOrNull(target);
      if (!stat) {
        // A not-yet-created root is the normal first-run state; report it as
        // empty rather than surfacing ENOENT as a tool error.
        if (target === root) return "(empty)";
        throw new Error(`no such memory path: ${command.path}`);
      }
      if (stat.isDirectory()) return await listDirectory(target);
      return renderLines(await readLines(target), command.view_range);
    },

    async create(command) {
      const target = resolveMemoryPath(root, command.path);
      await writeFileAt(target, command.file_text);
      return `wrote ${command.path}`;
    },

    async str_replace(command) {
      const target = resolveMemoryPath(root, command.path);
      const text = await fs.readFile(target, "utf8");
      const occurrences = command.old_str
        ? text.split(command.old_str).length - 1
        : 0;
      if (occurrences === 0) {
        throw new Error(`old_str not found in ${command.path}`);
      }
      if (occurrences > 1) {
        throw new Error(
          `old_str is not unique in ${command.path} (${occurrences} matches)`,
        );
      }
      // Splice by index rather than `text.replace(old, new)`: even with a
      // string pattern, `replace` expands `$&`, `` $` ``, `$'` and `$$` in the
      // *replacement*, so a note containing any of them would be silently
      // corrupted on write.
      const at = text.indexOf(command.old_str);
      const edited =
        text.slice(0, at) +
        command.new_str +
        text.slice(at + command.old_str.length);
      await fs.writeFile(target, edited, "utf8");
      return `edited ${command.path}`;
    },

    async insert(command) {
      const target = resolveMemoryPath(root, command.path);
      const lines = await readLines(target);
      if (command.insert_line < 0 || command.insert_line > lines.length) {
        throw new Error(
          `insert_line ${command.insert_line} out of range for ${command.path} (0-${lines.length})`,
        );
      }
      lines.splice(command.insert_line, 0, command.insert_text);
      await fs.writeFile(target, lines.join("\n"), "utf8");
      return `inserted into ${command.path} at line ${command.insert_line}`;
    },

    async delete(command) {
      const target = resolveMemoryPath(root, command.path);
      if (target === root) {
        throw new Error("refusing to delete the memory root");
      }
      await fs.rm(target, { recursive: true, force: true });
      return `deleted ${command.path}`;
    },

    async rename(command) {
      const from = resolveMemoryPath(root, command.old_path);
      const to = resolveMemoryPath(root, command.new_path);
      if (from === root || to === root) {
        throw new Error("refusing to rename the memory root");
      }
      if (await statOrNull(to)) {
        throw new Error(`destination already exists: ${command.new_path}`);
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return `renamed ${command.old_path} -> ${command.new_path}`;
    },
  };
}

/**
 * Build the Anthropic-defined memory tool over a filesystem backend.
 *
 * The object is the SDK's `betaMemoryTool(handlers)` product unchanged:
 * `{ type: "memory_20250818", name: "memory", parse, run }` where `run`
 * dispatches on `input.command`. It carries no `input_schema` (the model
 * knows the schema), so both runners project it onto the wire as
 * `{type, name}` — see `isAnthropicDefinedTool`. One cast at the boundary,
 * same pattern as `defineTool`: the SDK types `run` as returning
 * `string | BetaToolResultContentBlockParam[]`, and our handlers only ever
 * return strings.
 */
export function createMemoryTool(dir: string = DEFAULT_MEMORY_DIR): Tool {
  dbg.log(() => `memory tool rooted at ${path.resolve(dir)}`);
  return betaMemoryTool(createMemoryHandlers(dir)) as unknown as Tool;
}
