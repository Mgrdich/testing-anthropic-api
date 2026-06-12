import * as path from "node:path";

const ROOT = path.resolve(process.cwd(), "evals");

export function promptDir(name: string) {
  return path.join(ROOT, "prompts", name);
}

export function promptVersionFile(name: string, version: string) {
  return path.join(promptDir(name), `${version}.txt`);
}

export function auxPromptFile(
  name: string,
  kind: "generate" | "judge",
) {
  return path.join(promptDir(name), `${kind}.txt`);
}

export function codeEvalFile(name: string) {
  return path.join(promptDir(name), "code-eval.ts");
}

export function datasetPath(name: string) {
  return path.join(ROOT, "datasets", `${name}.jsonl`);
}

export function resultsDir(name: string) {
  return path.join(ROOT, "results", name);
}

export function runsPath(name: string, version: string) {
  return path.join(resultsDir(name), `${version}.runs.jsonl`);
}

export function codePath(name: string, version: string) {
  return path.join(resultsDir(name), `${version}.code.jsonl`);
}

export function gradedPath(name: string, version: string) {
  return path.join(resultsDir(name), `${version}.graded.jsonl`);
}

export function combinedPath(name: string, version: string) {
  return path.join(resultsDir(name), `${version}.combined.jsonl`);
}

export function combinedMarkdownPath(name: string, version: string) {
  return path.join(resultsDir(name), `${version}.combined.md`);
}
