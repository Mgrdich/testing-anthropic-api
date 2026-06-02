import * as fs from "node:fs";
import {
  auxPromptFile,
  codeEvalFile,
  codePath,
  combinedMarkdownPath,
  combinedPath,
  gradedPath,
  runsPath,
} from "@/eval/paths.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import {
  CodeRowSchema,
  CombinedRowSchema,
  GradedRowSchema,
  RunRowSchema,
  type CheckResult,
  type CodeRow,
  type CombinedRow,
  type GradedRow,
  type ModelGradeOrError,
  type RunRow,
} from "@/eval/types.ts";
import { runPromptOnDataset } from "@/eval/runner.ts";
import { gradeWithCode } from "@/eval/codeGrader.ts";
import { gradeWithModel } from "@/eval/modelGrader.ts";

export type CombineWeights = { code: number; model: number };

type CombineSummary = {
  total: number;
  scored: number;
  avgCombined: number;
  avgCode: number | null;
  avgModel: number | null;
  histogram: Record<number, number>;
  errors: number;
};

function bucket(score: number): number {
  if (score >= 5) return 5;
  if (score < 1) return 1;
  return Math.floor(score);
}

function isCodeOk(code: (CheckResult & { error?: boolean }) | undefined): code is CheckResult & { error?: false } {
  return code !== undefined && code.error !== true;
}

function isModelOk(
  model: ModelGradeOrError | undefined,
): model is Exclude<ModelGradeOrError, { error: string }> {
  return model !== undefined && !("error" in model);
}

function computeCombined(
  code: (CheckResult & { error?: boolean }) | undefined,
  model: ModelGradeOrError | undefined,
  weights: CombineWeights,
): number | { error: string } {
  const codeOk = isCodeOk(code);
  const modelOk = isModelOk(model);
  if (codeOk && modelOk) {
    const code5 = 1 + 4 * code.score;
    return weights.code * code5 + weights.model * model.score;
  }
  if (modelOk) return model.score;
  if (codeOk) return 1 + 4 * code.score;
  return { error: "no valid scores" };
}

function summarize(rows: readonly CombinedRow[]): CombineSummary {
  const histogram: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let combinedSum = 0;
  let scored = 0;
  let codeSum = 0;
  let codeCount = 0;
  let modelSum = 0;
  let modelCount = 0;
  let errors = 0;

  for (const row of rows) {
    if (isCodeOk(row.code)) {
      codeSum += row.code.score;
      codeCount++;
    }
    if (isModelOk(row.model)) {
      modelSum += row.model.score;
      modelCount++;
    }
    if (typeof row.combined === "number") {
      combinedSum += row.combined;
      scored++;
      histogram[bucket(row.combined)] =
        (histogram[bucket(row.combined)] ?? 0) + 1;
    } else {
      errors++;
    }
  }

  return {
    total: rows.length,
    scored,
    avgCombined: scored === 0 ? 0 : combinedSum / scored,
    avgCode: codeCount === 0 ? null : codeSum / codeCount,
    avgModel: modelCount === 0 ? null : modelSum / modelCount,
    histogram,
    errors,
  };
}

function formatAvgCode(avg: number | null): string {
  if (avg === null) return "—";
  return `${avg.toFixed(3)} (on [0,1]; equiv ${(1 + 4 * avg).toFixed(2)} on 1-5)`;
}

function formatSummary(s: CombineSummary): string {
  const histLine = [1, 2, 3, 4, 5]
    .map((b) => `${b}:${s.histogram[b] ?? 0}`)
    .join(" ");
  return [
    `avg combined: ${s.avgCombined.toFixed(2)} (over ${s.scored}/${s.total} valid rows)`,
    `avg code:     ${formatAvgCode(s.avgCode)}`,
    `avg model:    ${s.avgModel === null ? "—" : s.avgModel.toFixed(2)}`,
    `histogram:    ${histLine}`,
    `errors:       ${s.errors}`,
  ].join("\n");
}

function renderMarkdown(
  name: string,
  version: string,
  weights: CombineWeights,
  s: CombineSummary,
): string {
  const histLine = [1, 2, 3, 4, 5]
    .map((b) => `${b}:${s.histogram[b] ?? 0}`)
    .join(" ");
  return [
    `# ${name} ${version} — combined report`,
    "",
    `- weights:      code=${weights.code}, model=${weights.model}`,
    `- avg combined: ${s.avgCombined.toFixed(2)} (over ${s.scored}/${s.total} valid rows)`,
    `- avg code:     ${formatAvgCode(s.avgCode)}`,
    `- avg model:    ${s.avgModel === null ? "—" : s.avgModel.toFixed(2)}`,
    `- histogram:    ${histLine}`,
    `- errors:       ${s.errors}`,
    "",
  ].join("\n");
}

function parseRowsFromFile<T>(
  filePath: string,
  parse: (row: unknown, i: number) => T,
): T[] {
  return readJsonl(filePath).map((row, i) => parse(row, i));
}

function mtimeMs(p: string): number | null {
  if (!fs.existsSync(p)) return null;
  return fs.statSync(p).mtimeMs;
}

// Mtime-based (not existence-based) because combined's inputs are
// themselves cached tool outputs - an upstream `--force` rewrites them
// and a plain existence check would silently serve a stale join.
function isCombinedFresh(
  outPath: string,
  inputPaths: readonly string[],
): boolean {
  const outMtime = mtimeMs(outPath);
  if (outMtime === null) return false;
  for (const p of inputPaths) {
    const m = mtimeMs(p);
    if (m !== null && m > outMtime) return false;
  }
  return true;
}

export async function combineGrader(opts: {
  name: string;
  version: string;
  weights?: CombineWeights;
  markdown?: boolean;
  auto?: boolean;
  force?: boolean;
}): Promise<{
  path: string;
  mdPath?: string;
  count: number;
  summary: string;
  cached: boolean;
}> {
  const weights = opts.weights ?? { code: 0.5, model: 0.5 };
  const rPath = runsPath(opts.name, opts.version);
  const gPath = gradedPath(opts.name, opts.version);
  const cPath = codePath(opts.name, opts.version);
  const outPath = combinedPath(opts.name, opts.version);

  if (opts.auto) {
    if (!fs.existsSync(rPath)) {
      process.stderr.write(`[combined] auto: running prompt (runs.jsonl missing)\n`);
      await runPromptOnDataset({ name: opts.name, version: opts.version });
    }
    if (fs.existsSync(codeEvalFile(opts.name)) && !fs.existsSync(cPath)) {
      process.stderr.write(`[combined] auto: running code grader (code.jsonl missing)\n`);
      await gradeWithCode({ name: opts.name, version: opts.version });
    }
    if (fs.existsSync(auxPromptFile(opts.name, "judge")) && !fs.existsSync(gPath)) {
      process.stderr.write(`[combined] auto: running model grader (graded.jsonl missing)\n`);
      await gradeWithModel({ name: opts.name, version: opts.version });
    }
  }

  const haveGraded = fs.existsSync(gPath);
  const haveCode = fs.existsSync(cPath);

  if (!haveGraded && !haveCode) {
    throw new Error(
      `no graded or code results for ${opts.name}/${opts.version} - run \`bun run eval grade\` and/or \`bun run eval code\` first (or pass --auto)`,
    );
  }

  if (!opts.force && isCombinedFresh(outPath, [rPath, cPath, gPath])) {
    const cachedRows = parseRowsFromFile(outPath, (row, i) => {
      const r = CombinedRowSchema.safeParse(row);
      if (!r.success) {
        throw new Error(`cached combined row ${i} invalid: ${r.error.message}`);
      }
      return r.data;
    });
    process.stderr.write(
      `[combined] cache hit: ${outPath} (${cachedRows.length} rows; --force to recompute)\n`,
    );
    const s = summarize(cachedRows);
    const summary = formatSummary(s);
    let mdPath: string | undefined;
    if (opts.markdown) {
      mdPath = combinedMarkdownPath(opts.name, opts.version);
      if (!isCombinedFresh(mdPath, [outPath])) {
        fs.writeFileSync(
          mdPath,
          renderMarkdown(opts.name, opts.version, weights, s),
        );
      }
    }
    return {
      path: outPath,
      count: cachedRows.length,
      summary,
      cached: true,
      ...(mdPath ? { mdPath } : {}),
    };
  }

  const runs: RunRow[] = parseRowsFromFile(
    runsPath(opts.name, opts.version),
    (row, i) => {
      const r = RunRowSchema.safeParse(row);
      if (!r.success) throw new Error(`runs row ${i} invalid: ${r.error.message}`);
      return r.data;
    },
  );

  let graded: GradedRow[] | undefined;
  if (haveGraded) {
    graded = parseRowsFromFile(gPath, (row, i) => {
      const r = GradedRowSchema.safeParse(row);
      if (!r.success) throw new Error(`graded row ${i} invalid: ${r.error.message}`);
      return r.data;
    });
    if (graded.length !== runs.length) {
      throw new Error(
        `row count mismatch: runs=${runs.length}, graded=${graded.length} (rerun grade?)`,
      );
    }
  }

  let code: CodeRow[] | undefined;
  if (haveCode) {
    code = parseRowsFromFile(cPath, (row, i) => {
      const r = CodeRowSchema.safeParse(row);
      if (!r.success) throw new Error(`code row ${i} invalid: ${r.error.message}`);
      return r.data;
    });
    if (code.length !== runs.length) {
      throw new Error(
        `row count mismatch: runs=${runs.length}, code=${code.length} (rerun code?)`,
      );
    }
  }

  const combinedRows: CombinedRow[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run === undefined) {
      throw new Error(`tooling bug: missing run row at index ${i}`);
    }
    const gradedRow = graded?.[i];
    const codeRow = code?.[i];

    const codeResult = codeRow?.code;
    const modelResult = gradedRow?.model;
    const combined = computeCombined(codeResult, modelResult, weights);

    const row: CombinedRow = {
      ...run,
      ...(codeResult ? { code: codeResult } : {}),
      ...(modelResult ? { model: modelResult } : {}),
      combined,
    };

    const checked = CombinedRowSchema.safeParse(row);
    if (!checked.success) {
      throw new Error(
        `tooling bug: combined row failed schema: ${checked.error.message}`,
      );
    }
    combinedRows.push(checked.data);
  }

  writeJsonl(outPath, combinedRows);

  const s = summarize(combinedRows);
  const summary = formatSummary(s);

  let mdPath: string | undefined;
  if (opts.markdown) {
    mdPath = combinedMarkdownPath(opts.name, opts.version);
    fs.writeFileSync(
      mdPath,
      renderMarkdown(opts.name, opts.version, weights, s),
    );
  }

  return {
    path: outPath,
    count: combinedRows.length,
    summary,
    cached: false,
    ...(mdPath ? { mdPath } : {}),
  };
}
