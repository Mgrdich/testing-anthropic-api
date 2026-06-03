import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

// Security boundary: the regex whitelist below is what makes `new Function`
// safe here. No identifiers, no calls, no member access can appear in the
// expression — only arithmetic. Do not relax it without replacing the evaluator.
const SAFE_EXPRESSION = /^[\d+\-*/().\s]+$/;

export const calculator = defineTool({
  name: "calculator",
  description:
    "Evaluates a simple arithmetic expression containing only digits, decimals, parentheses, and the operators + - * /. Returns the numeric result.",
  inputSchema: z.object({
    expression: z
      .string()
      .describe("Arithmetic expression, e.g. '(2 + 3) * 4'"),
  }),
  run: ({ expression }) => {
    if (!SAFE_EXPRESSION.test(expression)) {
      throw new Error(
        "expression contains disallowed characters (only digits, decimals, parentheses, and + - * / are allowed)",
      );
    }
    const fn = new Function(`"use strict"; return (${expression});`);
    const result = fn();
    if (typeof result !== "number" || !Number.isFinite(result)) {
      throw new Error(`expression did not evaluate to a finite number`);
    }
    return String(result);
  },
});
