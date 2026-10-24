import { z } from 'zod';
import { createQualifiedDarwinProcessApi } from '../process/DarwinRegisteredProcess.js';
import { readPackagedProcessArtifact } from '../process/readPackagedProcessArtifact.js';

/** Private captured packaging selection only. No renderer/IPC/env/argv selection. */
export const processCustodyProfileSchema = z
  .object({
    directory: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.startsWith('/') && !value.includes('\0')),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ProcessCustody = ReturnType<typeof createQualifiedDarwinProcessApi>;
/** Loads the exact prebuilt tuple once. Absence never upgrades an unqualified PID. */
export function createProcessCustody(
  selection: z.infer<typeof processCustodyProfileSchema> | undefined
): ProcessCustody | undefined {
  return selection
    ? createQualifiedDarwinProcessApi(readPackagedProcessArtifact(selection))
    : undefined;
}
