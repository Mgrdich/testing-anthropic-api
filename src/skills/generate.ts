/**
 * Agent Skills (Messages API) — run an Anthropic-managed document skill
 * (pptx/xlsx/docx/pdf) inside a server-side code-execution container and
 * download every file it generates via the Files API.
 *
 * This is the Messages-API skills surface (`container.skills` + the
 * code-execution tool + dual betas), not Managed Agents — no
 * agents/sessions/environments involved.
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BetaContentBlock,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta";
import { AnthropicClient, DEFAULT_MODEL, Debug } from "@/core/index.ts";

/** Anthropic-managed document skills the demo exposes. */
export const SKILL_IDS = ["pptx", "xlsx", "docx", "pdf"] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export function isSkillId(value: string): value is SkillId {
  return (SKILL_IDS as readonly string[]).includes(value);
}

/** Both betas the Agent Skills surface requires on every request. */
const SKILLS_BETAS = ["code-execution-2025-08-25", "skills-2025-10-02"];

// Skill runs execute code server-side and produce long tool transcripts, so
// the project-wide DEFAULT_MAX_TOKENS (1024) would truncate mid-run.
const SKILLS_MAX_TOKENS = 16000;

// Current code-execution tool variant. SDK 0.98.0's BetaToolUnion stops at
// `code_execution_20260120`, so the literal is cast — the typings lag the
// API here; the wire shape ({type, name}) is unchanged.
const CODE_EXECUTION_TOOL = {
  type: "code_execution_20260521",
  name: "code_execution",
} as unknown as BetaToolUnion;

export type GenerateWithSkillOptions = {
  skill: SkillId;
  prompt: string;
  /** Directory generated files are written into (created if missing). */
  outDir: string;
  /** Anthropic model id; defaults to the project DEFAULT_MODEL. */
  model?: string;
  /** Called with each streamed text delta (the model's narration). */
  onText?: (text: string) => void;
};

export type GenerateWithSkillResult = {
  /** Paths of the downloaded artifacts, in response order. */
  savedPaths: string[];
  /** Warn-and-skip notes (unknown block shapes, unusable filenames, …). */
  warnings: string[];
  stopReason: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Walk the final content for `bash_code_execution_tool_result` blocks and
 * collect the `file_id` of every generated file. Tolerant of unknown block
 * shapes: anything unrecognized is reported via `warn` and skipped — the
 * response may carry block types newer than the SDK's unions.
 */
function collectFileIds(
  content: readonly BetaContentBlock[],
  warn: (msg: string) => void,
): string[] {
  const ids: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "bash_code_execution_tool_result") continue;
    const result: unknown = block.content;
    if (!isRecord(result) || result.type !== "bash_code_execution_result") {
      // Error results (bash_code_execution_tool_result_error) carry no
      // files; other shapes are unknown to us — skip either way.
      if (
        isRecord(result) &&
        result.type !== "bash_code_execution_tool_result_error"
      ) {
        warn(
          `unrecognized tool-result content (type=${String(result.type)}) — skipped`,
        );
      }
      continue;
    }
    if (!Array.isArray(result.content)) {
      warn("bash_code_execution_result without a content array — skipped");
      continue;
    }
    for (const item of result.content as unknown[]) {
      if (isRecord(item) && typeof item.file_id === "string") {
        if (!ids.includes(item.file_id)) ids.push(item.file_id);
      } else {
        warn(
          "unrecognized output block inside bash_code_execution_result — skipped",
        );
      }
    }
  }
  return ids;
}

/**
 * One-shot skills run: stream the request, then download every generated
 * file into `outDir` (filenames sanitized with `path.basename` before
 * writing — never trust server-provided paths).
 */
export async function generateWithSkill(
  opts: GenerateWithSkillOptions,
): Promise<GenerateWithSkillResult> {
  const dbg = Debug.get();
  const client = AnthropicClient.get();
  const model = opts.model ?? DEFAULT_MODEL;
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  dbg.section(`skills generate: ${opts.skill}`);
  dbg.log(`model=${model} out=${opts.outDir}`);

  const stream = client.beta.messages.stream({
    model,
    max_tokens: SKILLS_MAX_TOKENS,
    betas: SKILLS_BETAS,
    container: {
      skills: [{ type: "anthropic", skill_id: opts.skill, version: "latest" }],
    },
    tools: [CODE_EXECUTION_TOOL],
    messages: [{ role: "user", content: opts.prompt }],
  });
  if (opts.onText) stream.on("text", opts.onText);

  const final = await stream.finalMessage();
  dbg.log(
    `stop_reason=${final.stop_reason} container=${final.container?.id ?? "none"}`,
  );
  dbg.json("final content block types", () => final.content.map((b) => b.type));
  if (final.stop_reason === "max_tokens") {
    warn(
      `response truncated at max_tokens=${SKILLS_MAX_TOKENS} — artifacts may be incomplete`,
    );
  }

  const fileIds = collectFileIds(final.content, warn);
  dbg.log(
    `generated file ids: ${fileIds.length > 0 ? fileIds.join(", ") : "(none)"}`,
  );

  const savedPaths: string[] = [];
  if (fileIds.length > 0) mkdirSync(opts.outDir, { recursive: true });
  for (const fileId of fileIds) {
    const meta = await client.beta.files.retrieveMetadata(fileId);
    dbg.log(`file ${fileId}: ${meta.filename} (${meta.size_bytes} bytes)`);
    const safeName = path.basename(meta.filename);
    if (!safeName || safeName === "." || safeName === "..") {
      warn(
        `file ${fileId} has unusable filename ${JSON.stringify(meta.filename)} — skipped`,
      );
      continue;
    }
    // Files-API beta header is auto-sent by client.beta.files.*.
    const response = await client.beta.files.download(fileId);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const outPath = path.join(opts.outDir, safeName);
    await writeFile(outPath, bytes);
    savedPaths.push(outPath);
  }

  return { savedPaths, warnings, stopReason: final.stop_reason };
}
