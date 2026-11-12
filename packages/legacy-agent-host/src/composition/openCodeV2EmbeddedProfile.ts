import { z } from 'zod';
import { isCanonicalOpenCodeV2Directory } from './openCodeV2StaticPreflight.js';

/** Trusted delivery selection only. A model or renderer cannot choose executable code. */
export const openCodeV2EmbeddedProfileSchema = z.object({
  version: z.literal('2.1.4'),
  directory: z.string().min(1).max(8192),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  platform: z.enum(['linux', 'darwin', 'win32']),
  arch: z.enum(['x64', 'arm64']),
  externalDirectory: z.enum(['deny', 'ask']),
  /** Native configuration for this one captured provider, never a whole user config. */
  providerConfiguration: z.record(z.string(), z.json()).optional(),
}).strict().superRefine((value, context) => {
  if (value.platform !== process.platform || value.arch !== process.arch ||
      (value.platform === 'linux' && value.arch === 'arm64') ||
      !isCanonicalOpenCodeV2Directory(`${value.platform}-${value.arch}`, value.directory)) {
    context.addIssue({ code: 'custom', message: 'OpenCode V2 delivery must match the native platform' });
  }
  if (JSON.stringify(value.providerConfiguration ?? {}).length > 256 * 1024) {
    context.addIssue({ code: 'custom', message: 'OpenCode V2 provider configuration exceeds its budget' });
  }
});

export type OpenCodeV2EmbeddedProfile = z.infer<typeof openCodeV2EmbeddedProfileSchema>;
