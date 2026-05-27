import * as fs from "node:fs";
import { z } from "zod";
import {
  auxPromptFile,
  codeEvalFile,
  promptDir,
  promptVersionFile,
} from "@/eval/paths.ts";

export const CheckTemplateSchema = z.enum(["json", "zod", "regex", "none"]);
export type CheckTemplate = z.infer<typeof CheckTemplateSchema>;

const V1_TEMPLATE = `You are a helpful assistant. Answer the user's question clearly and concisely.
`;

const GENERATE_TEMPLATE = `You are generating an evaluation dataset for a prompt that <DESCRIBE
WHAT THE PROMPT UNDER TEST DOES>.

Produce a JSON array of {count} items. Each item must have:
  - "input":     a realistic user question or request
  - "reference": a concise gold answer (1-3 sentences)

You may add any custom fields the grader needs (e.g. "allowed",
"must_contain", "expected_schema"). Vary difficulty and topic.
Respond with the JSON array only - no prose, no code fences.
`;

const JUDGE_TEMPLATE = `You are grading an assistant's response.

Criteria (customize these for your prompt):
  - <CRITERION 1, e.g. "Is the answer factually accurate?">
  - <CRITERION 2, e.g. "Is it concise and on-topic?">
  - <CRITERION 3, e.g. "Does it directly address the question?">

You will receive the user's input, a reference answer, and the
assistant's output. Judge against the criteria above.
`;

const CODE_EVAL_JSON = `import type { CheckFn } from "@/eval/types.ts";
import { jsonCheck } from "@/eval/index.ts";

// Score 1 if output parses as JSON, 0 otherwise.
// Edit me: e.g. wrap with stripCodeFence, or combine with allChecks.
export const check: CheckFn = jsonCheck;
`;

const CODE_EVAL_ZOD = `import { z } from "zod";
import type { CheckFn } from "@/eval/types.ts";
import { zodCheck } from "@/eval/index.ts";

// TODO: replace this schema with the shape your prompt should return.
const Schema = z.object({
  // example fields - delete and replace:
  id: z.string(),
  name: z.string(),
});

// Set { stripFence: true } if your prompt sometimes wraps JSON in code fences.
export const check: CheckFn = zodCheck(Schema, { stripFence: false });
`;

const CODE_EVAL_REGEX = `import type { CheckFn } from "@/eval/types.ts";
import { regexCheck } from "@/eval/index.ts";

// Score 1 if output compiles as a JS RegExp, 0 otherwise.
export const check: CheckFn = regexCheck;
`;

function writeIfAbsent(filePath: string, content: string): "wrote" | "skipped" {
  if (fs.existsSync(filePath)) return "skipped";
  fs.writeFileSync(filePath, content);
  return "wrote";
}

export function createPromptScaffold(
  name: string,
  opts: { check: CheckTemplate } = { check: "none" },
): { wrote: string[]; skipped: string[] } {
  const dir = promptDir(name);
  fs.mkdirSync(dir, { recursive: true });

  const files: Array<{ path: string; content: string }> = [
    { path: promptVersionFile(name, "v1"), content: V1_TEMPLATE },
    { path: auxPromptFile(name, "generate"), content: GENERATE_TEMPLATE },
    { path: auxPromptFile(name, "judge"), content: JUDGE_TEMPLATE },
  ];

  if (opts.check !== "none") {
    const codeTemplate =
      opts.check === "json"
        ? CODE_EVAL_JSON
        : opts.check === "zod"
          ? CODE_EVAL_ZOD
          : CODE_EVAL_REGEX;
    files.push({ path: codeEvalFile(name), content: codeTemplate });
  }

  const wrote: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (writeIfAbsent(f.path, f.content) === "wrote") wrote.push(f.path);
    else skipped.push(f.path);
  }
  return { wrote, skipped };
}
