import { z } from 'zod';

/** Private native process selection shared by sessions and management, never an RPC payload. */
export const nativeProcessProfileSchema = z.object({
  cwd: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => value.startsWith('/')),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(64 * 1024)),
  executable: z
    .object({
      path: z
        .string()
        .min(1)
        .max(8192)
        .refine((value) => value.startsWith('/')),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
});

export type NativeProcessProfile = z.infer<typeof nativeProcessProfileSchema>;
