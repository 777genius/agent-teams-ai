import { z } from 'zod';

import { isNativeProfilePath } from '../owned-process/nativePath.js';
import { runtimeDigest } from '../runtime/identity.js';

const id = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.object({ teamId: id, projectId: id, workspaceId: id }).strict();

/** Private original-source selector. It carries no grant and is never a renderer/Runtime request. */
export const runtimeSourceProcessOriginSchema = z.object({
  sourceId: hash,
  revision: hash,
  origin: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('management'), profileId: id, configRevision: id }).strict(),
    z.object({ kind: z.literal('runtime'), scope,
      projectPath: z.string().min(1).max(8192).refine(isNativeProfilePath),
      teamId: id, memberId: id, recipeIdentity: hash }).strict(),
  ]),
}).strict();
export type RuntimeSourceProcessOrigin = z.infer<typeof runtimeSourceProcessOriginSchema>;

interface SourceRecipeIdentity {
  provider: string;
  accountBinding: string;
  executable: { path: string; sha256: string };
  environment: Record<string, string>;
  windowsBroker?: { path: string; sha256: string; arch: string; protocol: number; capability?: string | undefined } | undefined;
  nativeGeneration?: string | undefined;
  configNamespace?: string | undefined;
}

/** Stable original recipe identity; model/run/worktree derivation cannot substitute account or code. */
export function runtimeSourceRecipeIdentity(profile: SourceRecipeIdentity): string {
  return runtimeDigest({ provider: profile.provider, accountBinding: profile.accountBinding,
    executable: profile.executable,
    environment: Object.fromEntries(Object.entries(profile.environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    windowsBroker: profile.windowsBroker ?? null,
    nativeGeneration: profile.provider === 'opencode' ? profile.nativeGeneration ?? 'v1' : null,
    configNamespace: profile.provider === 'claude' ? profile.configNamespace ?? 'custom-directory' : null });
}
