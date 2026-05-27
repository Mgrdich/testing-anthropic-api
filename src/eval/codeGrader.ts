import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { codeEvalFile, codePath, runsPath } from "@/eval/paths.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import {
  CheckResultSchema,
  CodeRowSchema,
  RunRowSchema,
  type CheckFn,
  type CodeRow,
} from "@/eval/types.ts";
import { errMsg } from "@/eval/util.ts";

const CodeEvalModuleSchema = z.object({
  check: z.custom<CheckFn>((val) => typeof val === "function", {
    message: "expected a function",
  }),
});

function summarizeZodIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

export async function gradeWithCode(opts: {
  name: string;
  version: string;
}): Promise<{ path: string; count: number; summary: string } | null> {
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
  let perfect = 0;
  let zero = 0;
  let errors = 0;
  let totalScore = 0;

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

    totalScore += codeResult.score;
    if (codeResult.score === 1) perfect++;
    if (codeResult.score === 0) zero++;
    if (wasError) errors++;
  }

  const outPath = codePath(opts.name, opts.version);
  writeJsonl(outPath, codeRows);

  const avg = runs.length === 0 ? 0 : totalScore / runs.length;
  const summary = `avg score: ${avg.toFixed(3)} | perfect: ${perfect}/${runs.length} | zero: ${zero}/${runs.length} | errors: ${errors}`;
  return { path: outPath, count: codeRows.length, summary };
}
