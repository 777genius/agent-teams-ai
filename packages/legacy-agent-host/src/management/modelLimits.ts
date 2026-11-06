import { z } from 'zod';

/** The same finite token bounds as frozen product preferences. */
export const modelProbeLimitsSchema = z
  .object({
    contextTokens: z.number().int().min(1).max(100_000_000),
    outputTokens: z.number().int().min(1).max(100_000_000),
  })
  .strict()
  .refine((value) => value.outputTokens <= value.contextTokens);
