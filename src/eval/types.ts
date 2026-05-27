import { z } from "zod";

export const CheckResultSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string().min(1).optional(),
  details: z.unknown().optional(),
});

export type CheckResult = z.infer<typeof CheckResultSchema>;

export const DatasetItemSchema = z
  .object({
    input: z.string().min(1),
    reference: z.string().optional(),
  })
  .catchall(z.unknown());

export type DatasetItem = z.infer<typeof DatasetItemSchema>;

export type CheckFn = (output: string, item: DatasetItem) => CheckResult;

export const RunRowSchema = DatasetItemSchema.extend({
  output: z.string(),
});

export type RunRow = z.infer<typeof RunRowSchema>;

const CheckResultWithError = CheckResultSchema.extend({
  error: z.boolean().optional(),
});

export const CodeRowSchema = RunRowSchema.extend({
  code: CheckResultWithError,
});

export type CodeRow = z.infer<typeof CodeRowSchema>;

export const ModelGradeSchema = z.object({
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  reasoning: z.string().min(1),
  score: z.number().int().min(1).max(5),
});

export type ModelGrade = z.infer<typeof ModelGradeSchema>;

export const ModelGradeOrErrorSchema = z.union([
  ModelGradeSchema,
  z.object({
    error: z.string(),
    raw: z.string(),
  }),
]);

export type ModelGradeOrError = z.infer<typeof ModelGradeOrErrorSchema>;

export const GradedRowSchema = RunRowSchema.extend({
  model: ModelGradeOrErrorSchema,
});

export type GradedRow = z.infer<typeof GradedRowSchema>;
