import {
  addAssistantMessage,
  addUserMessage,
  type MessageParam,
} from "@/core/index.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL } from "@/core/constants.ts";
import { loadAuxPrompt } from "@/eval/prompts.ts";
import { gradedPath, runsPath } from "@/eval/paths.ts";
import { readJsonl, writeJsonl } from "@/eval/jsonl.ts";
import {
  GradedRowSchema,
  ModelGradeSchema,
  RunRowSchema,
  type GradedRow,
  type ModelGradeOrError,
} from "@/eval/types.ts";
import { errMsg } from "@/core/index.ts";

const FORMAT_FOOTER = `
Respond with a single JSON object - no prose, no code fences - matching
exactly this schema:
{
  "strengths":  [string, ...],
  "weaknesses": [string, ...],
  "reasoning":  string,
  "score":      integer 1-5
}
`;

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function summarizeIssues(
  issues: { path: PropertyKey[]; message: string }[],
): string {
  return issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

export async function gradeWithModel(opts: {
  name: string;
  version: string;
  model?: string;
}): Promise<{ path: string; count: number; summary: string }> {
  const judgeBody = loadAuxPrompt(opts.name, "judge");
  const system = judgeBody + FORMAT_FOOTER;
  const model = opts.model ?? DEFAULT_MODEL;

  const runs = readJsonl(runsPath(opts.name, opts.version)).map((row, i) => {
    const result = RunRowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`runs row ${i} invalid: ${result.error.message}`);
    }
    return result.data;
  });

  const gradedRows: GradedRow[] = [];
  const histogram: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const sampleRationales: string[] = [];
  let totalScore = 0;
  let scored = 0;
  let errors = 0;

  for (const [i, run] of runs.entries()) {
    process.stderr.write(`[grade] ${i + 1}/${runs.length}\n`);

    const messages: MessageParam[] = [];
    addUserMessage(
      messages,
      `<input>\n${run.input}\n</input>\n\n<reference>\n${run.reference ?? "(none)"}\n</reference>\n\n<output>\n${run.output}\n</output>`,
    );

    const response = await addAssistantMessage(messages, {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

    let modelResult: ModelGradeOrError;
    try {
      const parsed = extractJsonObject(raw);
      const validated = ModelGradeSchema.safeParse(parsed);
      if (validated.success) {
        modelResult = validated.data;
        totalScore += validated.data.score;
        scored++;
        histogram[validated.data.score] =
          (histogram[validated.data.score] ?? 0) + 1;
        if (sampleRationales.length < 3) {
          sampleRationales.push(
            `  score ${validated.data.score}: ${validated.data.reasoning}`,
          );
        }
      } else {
        modelResult = {
          error: `malformed judge output: ${summarizeIssues(validated.error.issues)}`,
          raw,
        };
        errors++;
      }
    } catch (e) {
      modelResult = {
        error: `parse failed: ${errMsg(e)}`,
        raw,
      };
      errors++;
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

  const outPath = gradedPath(opts.name, opts.version);
  writeJsonl(outPath, gradedRows);

  const avg = scored === 0 ? 0 : totalScore / scored;
  const histLine = [1, 2, 3, 4, 5]
    .map((s) => `${s}:${histogram[s] ?? 0}`)
    .join(" ");
  const summary = [
    `avg score: ${avg.toFixed(2)} (over ${scored}/${runs.length} valid rows)`,
    `histogram: ${histLine}`,
    `errors: ${errors}`,
    "sample rationales:",
    ...sampleRationales,
  ].join("\n");

  return { path: outPath, count: gradedRows.length, summary };
}
