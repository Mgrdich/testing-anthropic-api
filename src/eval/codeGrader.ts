import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { errMsg } from "@/core/index.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import { codeEvalFile, codePath, runsPath } from "@/eval/paths.ts";
import {
  type CheckFn,
  CheckResultSchema,
  type CodeRow,
  CodeRowSchema,
  RunRowSchema,
} from "@/eval/types.ts";

const CodeEvalModuleSchema = z.object({
  check: z.custom<CheckFn>((val) => typeof val === "function", {
    message: "expected a function",
  }),
});

function summarizeZodIssues(
  issues: { path: PropertyKey[]; message: string }[],
) {
  return issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

function summarizeCodeRows(rows: readonly CodeRow[]) {
  let perfect = 0;
  let zero = 0;
  let errors = 0;
  let totalScore = 0;

  for (const row of rows) {
    totalScore += row.code.score;
    if (row.code.score === 1) perfect++;
    if (row.code.score === 0) zero++;
    if (row.code.error === true) errors++;
  }

  const avg = rows.length === 0 ? 0 : totalScore / rows.length;
  return `avg score: ${avg.toFixed(3)} | perfect: ${perfect}/${rows.length} | zero: ${zero}/${rows.length} | errors: ${errors}`;
}

export async function gradeWithCode(opts: {
  name: string;
  version: string;
  force?: boolean;
}) {
  const outPath = codePath(opts.name, opts.version);

  if (!opts.force && fs.existsSync(outPath)) {
    const cached = readJsonl(outPath).map((row, i) => {
      const result = CodeRowSchema.safeParse(row);
      if (!result.success) {
        throw new Error(
          `cached code row ${i} invalid: ${result.error.message}`,
        );
      }
      return result.data;
    });
    process.stderr.write(
      `[code] cache hit: ${outPath} (${cached.length} rows; --force to re-run)\n`,
    );
    return {
      path: outPath,
      count: cached.length,
      summary: summarizeCodeRows(cached),
      cached: true,
    };
  }

  const evalFile = codeEvalFile(opts.name);
  if (!fs.existsSync(evalFile)) {
    process.stderr.write(`no code-eval.ts at ${evalFile} - skipping\n`);
    return null;
  }

  const mod: unknown = await import(path.resolve(evalFile));
  const parsed = CodeEvalModuleSchema.safeParse(mod);
  if (!parsed.success) {
    throw new Error(
      `${evalFile}: invalid module shape - ${summarizeZodIssues(parsed.error.issues)}\n` +
        `  expected: export const check: CheckFn (or export function check)`,
    );
  }
  const checkFn = parsed.data.check;

  const runs = readJsonl(runsPath(opts.name, opts.version)).map((row, i) => {
    const result = RunRowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`runs row ${i} invalid: ${result.error.message}`);
    }
    return result.data;
  });

  const codeRows: CodeRow[] = [];

  for (const run of runs) {
    let raw: unknown;
    let wasError = false;
    try {
      raw = checkFn(run.output, run);
    } catch (e) {
      raw = {
        score: 0,
        reason: `check threw: ${errMsg(e)}`,
      };
      wasError = true;
    }

    let validated = CheckResultSchema.safeParse(raw);
    if (!validated.success) {
      raw = {
        score: 0,
        reason: `check returned malformed result: ${summarizeZodIssues(validated.error.issues)}`,
      };
      wasError = true;
      validated = CheckResultSchema.safeParse(raw);
    }

    if (!validated.success) {
      throw new Error(
        `tooling bug: synthetic error result failed schema: ${validated.error.message}`,
      );
    }

    const codeResult = wasError
      ? { ...validated.data, error: true }
      : validated.data;

    const row: CodeRow = { ...run, code: codeResult };
    const checked = CodeRowSchema.safeParse(row);
    if (!checked.success) {
      throw new Error(
        `tooling bug: code row failed schema: ${checked.error.message}`,
      );
    }
    codeRows.push(checked.data);
  }

  writeJsonl(outPath, codeRows);
  return {
    path: outPath,
    count: codeRows.length,
    summary: summarizeCodeRows(codeRows),
    cached: false,
  };
}
