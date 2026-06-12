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

const GENERATE_TEMPLATE = `You are generating an evaluation dataset.

<prompt_under_test>
TODO: describe what the prompt being evaluated does. Be specific
about the domain, the input it takes, and the output it produces.
</prompt_under_test>

<input_style>
TODO: customize if needed. The default works for general Q&A:

Each "input" is a realistic short user question or request, 1-2
sentences. Vary domain (science, history, geography, technology,
everyday knowledge) and difficulty. Include at least one item that
requires a multi-step reasoning step and one that is purely factual
recall. Avoid trick questions or anything ambiguous.
</input_style>

<reference_style>
TODO: customize if needed. The default works for general Q&A:

Each "reference" is a concise gold answer, 1-2 sentences. Factual,
directly addresses the question, no preamble like "Sure, ..." or
"The answer is ...". Plain declarative tone.
</reference_style>

<custom_fields>
TODO: list any extra fields your code-eval.ts or judge.txt expects on
each item (e.g. "allowed", "must_contain", "max_chars"). Delete this
block if you don't need any.
</custom_fields>

Produce a JSON array of {count} items. Each item must have at minimum:
  - "input":     matching <input_style>
  - "reference": matching <reference_style>
  - plus any fields declared in <custom_fields>

Vary difficulty and topic across items. Respond with the JSON array
only - no prose, no code fences.
`;

const JUDGE_TEMPLATE = `You are grading an assistant's response.

<prompt_under_test>
TODO: describe what the prompt being graded was supposed to do.
</prompt_under_test>

<criteria>
TODO: customize if needed. The default works for general Q&A:

  - Is the answer factually accurate (consistent with the reference)?
  - Is it concise (1-2 sentences) and on-topic?
  - Does it directly address the question without preamble?
</criteria>

Score scale is fixed at integer 1-5 by the harness. Customize what
each number means below; do not change the range.

<reference_meaning>
TODO: explain how the judge should use <reference>. Examples:
  - Q&A: "<reference> is the gold answer. Output should match it."
  - Hinter: "<reference> is the target answer. Hint must point
    toward it without stating it."
Note: <reference> is LLM-generated, treat as a strong example,
not absolute ground truth.
</reference_meaning>

<scoring>
TODO: customize if needed. The default works for general Q&A:

  5 = correct, concise, direct
  3-4 = correct but verbose or off-format
  1-2 = wrong, off-topic, or missing key info
</scoring>

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
) {
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
