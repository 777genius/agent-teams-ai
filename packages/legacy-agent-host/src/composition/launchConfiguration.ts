import { z } from 'zod';
import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
const options = z
  .object({
    model: id.optional(),
    effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    fastMode: z.boolean().optional(),
    permissions: z.enum(['manual', 'bypass']).optional(),
    context: z.enum(['model-default', 'one-million']).optional(),
  })
  .strict();

/** App choices only: executable/account/environment/native identity remain captured. */
export const launchConfigurationSchema = z
  .object({
    members: z
      .array(options.extend({ memberId: id }).strict())
      .min(1)
      .max(256),
  })
  .strict()
  .refine(
    (value) => new Set(value.members.map((member) => member.memberId)).size === value.members.length
  );

/** The same deterministic mapping is used before allocation and after Host restart. */
export function applyLaunchConfiguration(
  base: RuntimeMemberProfile,
  raw: unknown
): RuntimeMemberProfile {
  const selected = options.parse(raw);
  const profile = structuredClone(base);
  if (selected.model !== undefined) {
    const prefix = profile.provider === 'opencode' ? `${profile.nativeOptions.providerId}/` : null;
    // App catalogs qualify OpenCode model IDs; private recipes may already contain
    // bare IDs with slashes. Only the captured provider's exact prefix is removed.
    profile.model =
      prefix && selected.model.startsWith(prefix)
        ? selected.model.slice(prefix.length)
        : selected.model;
  }
  if (profile.provider === 'claude') {
    if (selected.effort === 'none' || selected.effort === 'minimal' || selected.effort === 'ultra')
      throw new TeamLaunchError('invalid', 'launch-option-unsupported');
    profile.nativeOptions = {
      ...profile.nativeOptions,
      ...(selected.effort === undefined ? {} : { effort: selected.effort }),
      ...(selected.fastMode === undefined ? {} : { fastMode: selected.fastMode }),
      ...(selected.context === undefined ? {} : { context: selected.context }),
      ...(selected.permissions === undefined
        ? {}
        : {
            permissionMode: selected.permissions === 'bypass' ? 'bypassPermissions' : 'default',
            allowDangerouslySkipPermissions: selected.permissions === 'bypass',
          }),
    };
    // Required Team tools are composed separately; manual mode must not inherit
    // a prior allowlist that silently approves native Bash/Edit requests.
    if (selected.permissions === 'manual') profile.autoAllowedTools = [];
  } else {
    if (
      selected.context !== undefined ||
      (profile.provider === 'opencode' && selected.fastMode !== undefined)
    )
      throw new TeamLaunchError('invalid', 'launch-option-unsupported');
    if (profile.provider === 'codex')
      profile.nativeOptions = {
        ...profile.nativeOptions,
        ...(selected.effort === undefined ? {} : { reasoningEffort: selected.effort }),
        ...(selected.fastMode === undefined ? {} : { fastMode: selected.fastMode }),
        ...(selected.permissions === undefined
          ? {}
          : {
              approvalPolicy: selected.permissions === 'bypass' ? 'never' : 'on-request',
              sandbox: selected.permissions === 'bypass' ? 'danger-full-access' : 'workspace-write',
            }),
      };
    if (profile.provider === 'opencode')
      profile.nativeOptions = {
        ...profile.nativeOptions,
        ...(selected.effort === undefined ? {} : { variant: selected.effort }),
        ...(selected.permissions === undefined
          ? {}
          : { toolApprovalMode: selected.permissions === 'bypass' ? 'auto' : 'manual' }),
      };
  }

  profile.configRevision = `launch-${runtimeDigest({ revision: base.configRevision, options: selected })}`;
  return runtimeMemberProfileSchema.parse(profile);
}
