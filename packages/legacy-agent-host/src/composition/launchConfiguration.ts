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
// A V2 catalog alias can contain two independently captured 256-character IDs
// plus a separator. Wider values are admitted only for that exact alias below.
const launchModelId = z.string().min(1).max(513).refine((value) => !value.includes('\0'));
const options = z
  .object({
    model: launchModelId.optional(),
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
  // The native V2 session already owns its model/variant. Host launch options
  // cannot change it. Reject explicit effort until a separate native variant
  // attestation exists; a matching captured string alone proves nothing.
  const v2 = base.provider === 'opencode' && base.nativeGeneration === 'v2';
  // A slash inside a custom provider ID makes the flattened catalog alias
  // ambiguous with another provider's model path. Without structured catalog
  // provenance, an explicit choice cannot attest that captured native pair.
  const qualifiedCapturedModel = v2 && !base.nativeOptions.providerId.includes('/')
    ? `${base.nativeOptions.providerId}/${base.model}`
    : undefined;
  if (selected.model !== undefined && selected.model.length > 256 &&
      (!v2 || selected.model !== qualifiedCapturedModel))
    throw new TeamLaunchError('invalid', 'launch-option-unsupported');
  if (v2) {
    // Only an exact provider-qualified catalog alias identifies the captured
    // model. A bare model ID, even when its spelling matches, has no provider
    // provenance and must not select another native session by accident.
    const modelMatches = selected.model === undefined ||
      selected.model === qualifiedCapturedModel;
    if (selected.permissions !== undefined || selected.effort !== undefined || !modelMatches)
      throw new TeamLaunchError('invalid', 'launch-option-unsupported');
  }
  const profile = structuredClone(base);
  // For V2, the selected native session has already fixed its model. Keep the
  // captured identity exactly; a UI-qualified alias must not rewrite it.
  if (selected.model !== undefined &&
      !(profile.provider === 'opencode' && profile.nativeGeneration === 'v2')) {
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
