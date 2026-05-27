import * as path from "node:path";

const ROOT = path.resolve(process.cwd(), "evals");

export function promptDir(name: string): string {
  return path.join(ROOT, "prompts", name);
}

export function promptVersionFile(name: string, version: string): string {
  return path.join(promptDir(name), `${version}.txt`);
}

export function auxPromptFile(
  name: string,
  kind: "generate" | "judge",
): string {
  return path.join(promptDir(name), `${kind}.txt`);
}

export function codeEvalFile(name: string): string {
  return path.join(promptDir(name), "code-eval.ts");
}

export function datasetPath(name: string): string {
  return path.join(ROOT, "datasets", `${name}.jsonl`);
}

export function resultsDir(name: string): string {
  return path.join(ROOT, "results", name);
}

export function runsPath(name: string, version: string): string {
  return path.join(resultsDir(name), `${version}.runs.jsonl`);
}

export function codePath(name: string, version: string): string {
  return path.join(resultsDir(name), `${version}.code.jsonl`);
}

export function gradedPath(name: string, version: string): string {
  return path.join(resultsDir(name), `${version}.graded.jsonl`);
}
