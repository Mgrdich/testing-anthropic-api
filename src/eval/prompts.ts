import * as fs from "node:fs";
import { auxPromptFile, promptDir, promptVersionFile } from "@/eval/paths.ts";

function readOrThrow(filePath: string, hint: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      throw new Error(`missing file: ${filePath}\n  ${hint}`);
    }
    throw e;
  }
}

export function loadPromptVersion(name: string, version: string) {
  return readOrThrow(
    promptVersionFile(name, version),
    `create it (e.g. ${promptDir(name)}/${version}.txt) or run \`bun run eval scaffold ${name}\`.`,
  );
}

export function loadAuxPrompt(name: string, kind: "generate" | "judge") {
  return readOrThrow(
    auxPromptFile(name, kind),
    `run \`bun run eval scaffold ${name}\` to generate template files.`,
  );
}
