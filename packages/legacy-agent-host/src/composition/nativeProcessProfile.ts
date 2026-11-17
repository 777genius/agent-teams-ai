import { z } from 'zod';
import { isCanonicalNativePath, isNativeProfilePath } from '../owned-process/nativePath.js';
export { isNativeProfilePath } from '../owned-process/nativePath.js';

/** OS comes from this Host, never a renderer-supplied platform or translated slash alias. */
export const nativeProfilePathSchema = z.string().min(1).max(8192).refine(isNativeProfilePath);

/** Private native process selection shared by sessions and management, never an RPC payload. */
export const nativeProcessProfileSchema = z.object({
  cwd: nativeProfilePathSchema,
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(64 * 1024)),
  executable: z
    .object({
      path: nativeProfilePathSchema,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  /** Private product-delivery selection; not supplied by runtime RPC or provider discovery. */
  windowsBroker: z.object({
    path: z.string().min(1).max(8192).refine(value => isCanonicalNativePath('win32-x64', value)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    arch: z.enum(['x64', 'arm64']),
    protocol: z.literal(1),
  }).strict().optional(),
});

export type NativeProcessProfile = z.infer<typeof nativeProcessProfileSchema>;
