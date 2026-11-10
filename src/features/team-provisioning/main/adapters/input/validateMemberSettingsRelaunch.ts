import { isTeamEffortLevel } from '@shared/utils/effortLevels';

import type { ReplaceMembersRequest } from '@shared/types';

export function validateMemberSettingsRelaunch(
  value: unknown
): ReplaceMembersRequest['memberSettingsRelaunch'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object')
    throw new Error('Invalid member settings relaunch intent');
  const input = value as Record<string, unknown>;
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0;
  if (
    !text(input.memberName) ||
    !text(input.expectedFingerprint) ||
    !text(input.expectedTeamSettingsFingerprint) ||
    (input.targetKind !== 'lead' && input.targetKind !== 'member') ||
    (input.model !== null && !text(input.model)) ||
    (input.effort !== null && !isTeamEffortLevel(input.effort)) ||
    !Array.isArray(input.baseline) ||
    input.baseline.length === 0 ||
    input.baseline.length > 1000
  ) {
    throw new Error('Invalid member settings relaunch intent');
  }
  const names = new Set<string>();
  const baseline = input.baseline.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid relaunch baseline');
    const row = value as Record<string, unknown>;
    if (
      !text(row.memberName) ||
      !text(row.expectedFingerprint) ||
      names.has(row.memberName.toLowerCase())
    ) {
      throw new Error('Invalid relaunch baseline');
    }
    names.add(row.memberName.toLowerCase());
    return { memberName: row.memberName, expectedFingerprint: row.expectedFingerprint };
  });
  return {
    memberName: input.memberName,
    targetKind: input.targetKind,
    expectedFingerprint: input.expectedFingerprint,
    expectedTeamSettingsFingerprint: input.expectedTeamSettingsFingerprint,
    baseline,
    model: input.model,
    effort: input.effort,
  };
}
