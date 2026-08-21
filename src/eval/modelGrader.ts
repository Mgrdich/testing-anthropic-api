import * as fs from "node:fs";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";
import {
  addUserMessage,
  errMsg,
  type MessageParam,
  parseAssistantMessage,
} from "@/core/index.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import { gradedPath, runsPath } from "@/eval/paths.ts";
import { loadAuxPrompt } from "@/eval/prompts.ts";
import {
  type GradedRow,
  GradedRowSchema,
  type ModelGradeOrError,
  ModelGradeSchema,
  RunRowSchema,
} from "@/eval/types.ts";

function summarizeGradedRows(rows: readonly GradedRow[]) {
  const histogram: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const sampleRationales: string[] = [];
  let totalScore = 0;
  let scored = 0;
  let errors = 0;

  for (const row of rows) {
    if ("error" in row.model) {
      errors++;
      continue;
    }
    totalScore += row.model.score;
    scored++;
    histogram[row.model.score] = (histogram[row.model.score] ?? 0) + 1;
    if (sampleRationales.length < 3) {
      sampleRationales.push(
        `  score ${row.model.score}: ${row.model.reasoning}`,
      );
    }
  }

  const avg = scored === 0 ? 0 : totalScore / scored;
  const histLine = [1, 2, 3, 4, 5]
    .map((s) => `${s}:${histogram[s] ?? 0}`)
    .join(" ");
  return [
    `avg score: ${avg.toFixed(2)} (over ${scored}/${rows.length} valid rows)`,
    `histogram: ${histLine}`,
    `errors: ${errors}`,
    "sample rationales:",
    ...sampleRationales,
  ].join("\n");
}

export async function gradeWithModel(opts: {
  name: string;
  version: string;
  model?: string;
  force?: boolean;
}) {
  const outPath = gradedPath(opts.name, opts.version);

  if (!opts.force && fs.existsSync(outPath)) {
    const cached = readJsonl(outPath).map((row, i) => {
      const result = GradedRowSchema.safeParse(row);
      if (!result.success) {
        throw new Error(
          `cached graded row ${i} invalid: ${result.error.message}`,
        );
      }
      return result.data;
    });
    process.stderr.write(
      `[grade] cache hit: ${outPath} (${cached.length} rows; --force to re-run)\n`,
    );
    return {
      path: outPath,
      count: cached.length,
      summary: summarizeGradedRows(cached),
      cached: true,
    };
  }

  // Structured output carries the response schema (ModelGradeSchema), so the
  // judge prompt no longer needs a hand-written JSON-format footer.
  const system = loadAuxPrompt(opts.name, "judge");
  const model = opts.model ?? DEFAULT_MODEL;

  const runs = readJsonl(runsPath(opts.name, opts.version)).map((row, i) => {
    const result = RunRowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`runs row ${i} invalid: ${result.error.message}`);
    }
    return result.data;
  });

  const gradedRows: GradedRow[] = [];

  for (const [i, run] of runs.entries()) {
    process.stderr.write(`[grade] ${i + 1}/${runs.length}\n`);

    const messages: MessageParam[] = [];
    addUserMessage(
      messages,
      `<input>\n${run.input}\n</input>\n\n<reference>\n${run.reference ?? "(none)"}\n</reference>\n\n<output>\n${run.output}\n</output>`,
    );

    let modelResult: ModelGradeOrError;
    try {
      const { parsed } = await parseAssistantMessage(
        messages,
        ModelGradeSchema,
        {
          model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system,
        },
      );
      modelResult = parsed;
    } catch (e) {
      // A refusal, truncation, or schema-validation failure yields an error
      // row rather than crashing the batch. The SDK throws before returning,
      // so the raw model text isn't recoverable here — the error message
      // carries the failure detail instead.
      modelResult = { error: `judge failed: ${errMsg(e)}`, raw: "" };
    }

    const row: GradedRow = { ...run, model: modelResult };
    const checked = GradedRowSchema.safeParse(row);
    if (!checked.success) {
      throw new Error(
        `tooling bug: graded row failed schema: ${checked.error.message}`,
      );
    }
    gradedRows.push(checked.data);
  }

  writeJsonl(outPath, gradedRows);
  return {
    path: outPath,
    count: gradedRows.length,
    summary: summarizeGradedRows(gradedRows),
    cached: false,
  };
}
