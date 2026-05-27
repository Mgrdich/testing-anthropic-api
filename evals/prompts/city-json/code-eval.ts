import { z } from "zod";
import type { CheckFn } from "@/eval/types.ts";
import { zodCheck } from "@/eval/index.ts";

const Schema = z.object({
  city: z.string().min(1),
  country: z.string().min(1),
  population: z.number().int().positive(),
});

export const check: CheckFn = zodCheck(Schema, { stripFence: true });
