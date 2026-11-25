import { ManagementCommandError } from '../management/commandRecords.js';
import { openCodeManagementProfileSchema } from '../management/profile.js';
import { TeamLaunchError } from '../team-launch/contracts.js';

import type { OpenCodeManagementProfile } from '../management/profile.js';
import type { OpenCodeMemberProfile } from './runtimeProfile.js';

interface NativeModel {
  providerId: string;
  modelId: string;
}
const validId = (value: string) =>
  value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);

/** Existing UI aliases are decoded once before allocation; native IDs stay structured afterwards. */
export function selectOpenCodeV2LaunchModel(
  base: OpenCodeMemberProfile,
  input: { model?: string | undefined; effort?: string | undefined }
): OpenCodeMemberProfile {
  if (base.nativeGeneration !== 'v2' || base.protocolRevision !== '2.1.4' || !base.embedded)
    throw new TeamLaunchError('invalid', 'launch-option-unsupported');
  const selected: NativeModel = { providerId: base.nativeOptions.providerId, modelId: base.model };
  if (input.model !== undefined) {
    const separator = input.model.indexOf('/');
    // A known bare ID or provider containing '/' is ambiguous in the existing flattened UI contract.
    if (separator < 1 || base.nativeOptions.providerId.includes('/') || input.model === base.model)
      throw new TeamLaunchError('invalid', 'launch-option-unsupported');
    selected.providerId = input.model.slice(0, separator);
    selected.modelId = input.model.slice(separator + 1);
    if (!validId(selected.providerId) || !validId(selected.modelId))
      throw new TeamLaunchError('invalid', 'launch-option-unsupported');
  }
  const profile = structuredClone(base);
  if (selected.providerId !== base.nativeOptions.providerId)
    delete profile.embedded!.providerConfiguration;
  if (selected.providerId !== base.nativeOptions.providerId || selected.modelId !== base.model)
    delete profile.nativeOptions.variant;
  profile.model = selected.modelId;
  profile.nativeOptions.providerId = selected.providerId;
  if (input.effort !== undefined) profile.nativeOptions.variant = input.effort;
  return profile;
}

/** A finite probe derives the same model choice while keeping its original management owner. */
export function selectOpenCodeV2ManagementModel(
  base: OpenCodeManagementProfile,
  input: { providerId: string; modelId: string; effort?: string | undefined }
): OpenCodeManagementProfile {
  if (
    base.nativeGeneration !== 'v2' ||
    base.protocolRevision !== '2.1.4' ||
    !base.embedded ||
    !base.nativeModel ||
    !validId(input.providerId)
  )
    throw new ManagementCommandError('invalid');
  const prefix = input.providerId + '/';
  const modelId =
    input.providerId === base.nativeModel.providerId && input.modelId === base.nativeModel.modelId
      ? input.modelId
      : input.modelId.startsWith(prefix)
        ? input.modelId.slice(prefix.length)
        : input.modelId;
  if (!validId(modelId)) throw new ManagementCommandError('invalid');
  const profile = structuredClone(base);
  if (input.providerId !== base.nativeModel.providerId)
    delete profile.embedded!.providerConfiguration;
  if (input.providerId !== base.nativeModel.providerId || modelId !== base.nativeModel.modelId)
    delete profile.variant;
  profile.nativeModel = { providerId: input.providerId, modelId };
  if (input.effort !== undefined) profile.variant = input.effort;
  return openCodeManagementProfileSchema.parse(profile);
}
