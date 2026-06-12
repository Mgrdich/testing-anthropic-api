import { z } from "zod";
import type { CheckFn, CheckResult, DatasetItem } from "@/eval/types.ts";
import { errMsg } from "@/core/index.ts";

export function stripCodeFence(s: string) {
  const trimmed = s.trim();
  const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/m.exec(trimmed);
  return fenced && fenced[1] !== undefined ? fenced[1].trim() : trimmed;
}

export function zodCheck<S extends z.ZodTypeAny>(
  schema: S,
  opts: { stripFence?: boolean } = {},
) {
  return (output: string) => {
    const text = opts.stripFence ? stripCodeFence(output) : output;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return {
        score: 0,
        reason: `invalid JSON: ${errMsg(e)}`,
      };
    }
    const result = schema.safeParse(parsed);
    if (result.success) return { score: 1 };
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return {
      score: 0,
      reason: `schema mismatch: ${issues}`,
      details: result.error.issues,
    };
  };
}

export const jsonCheck: CheckFn = (output: string) => {
  try {
    JSON.parse(output);
    return { score: 1 };
  } catch (e) {
    return { score: 0, reason: `invalid JSON: ${errMsg(e)}` };
  }
};

export const regexCheck: CheckFn = (output: string) => {
  try {
    new RegExp(output);
    return { score: 1 };
  } catch (e) {
    return { score: 0, reason: `invalid regex: ${errMsg(e)}` };
  }
};

export function allChecks(map: Record<string, CheckFn>) {
  const entries = Object.entries(map);
  return (output: string, item: DatasetItem) => {
    const details: Record<string, CheckResult> = {};
    let passing = 0;
    const failed: string[] = [];
    for (const [name, check] of entries) {
      let result: CheckResult;
      try {
        result = check(output, item);
      } catch (e) {
        result = { score: 0, reason: `threw: ${errMsg(e)}` };
      }
      details[name] = result;
      if (result.score === 1) passing++;
      else failed.push(name);
    }
    const total = entries.length;
    const score = total === 0 ? 1 : passing / total;
    const reason =
      passing === total
        ? undefined
        : `${total - passing} of ${total} criteria failed: ${failed.join(", ")}`;
    return reason === undefined
      ? { score, details }
      : { score, reason, details };
  };
}
