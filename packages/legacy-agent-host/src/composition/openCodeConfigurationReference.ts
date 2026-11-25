import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
export const openCodeConfiguredModelSchema = z
  .object({
    providerId: id.refine((value) => !value.includes('/') && !value.includes('#')),
    modelId: id.refine((value) => !value.includes('#')),
    variant: id.refine((value) => !value.includes('#')).optional(),
  })
  .strict();
export type OpenCodeConfiguredModel = z.infer<typeof openCodeConfiguredModelSchema>;
/** Private source identities only. Raw configuration and credential bytes never enter a receipt. */
export const openCodeConfigurationReferenceSchema = z
  .object({
    scope: z.enum(['global', 'project']),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(8192)
              .refine(
                (value) => !value.includes('\0') && isAbsolute(value) && resolve(value) === value
              ),
            digest,
          })
          .strict()
      )
      .max(7),
    inlineDigest: digest.nullable(),
  })
  .strict();
export type OpenCodeConfigurationReference = z.infer<typeof openCodeConfigurationReferenceSchema>;
