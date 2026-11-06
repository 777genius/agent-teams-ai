import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import type { TeamBinding } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { ReplaceTeamRoster } from './rosterContracts.js';

/** Owner-issued product version token; no app/runtime settings fingerprint semantics. */
export function memberSettingsFingerprint(
  binding: TeamBinding,
  revision: string,
  memberId: string
): string {
  return digest({ binding, revision, memberId });
}

/** An existing settings editor may update choices, never mutate membership identity. */
export function validateMemberSettingsRelaunch(
  binding: TeamBinding,
  state: OwnerState,
  input: ReplaceTeamRoster,
  revision: string
): void {
  const intent = input.memberSettingsRelaunch;
  if (!intent) return;
  const refuse = (): never => {
    throw new TeamOwnerError('conflict');
  };
  if (intent.expectedTeamSettingsFingerprint !== revision) refuse();
  const target = state.members.find((member) => member.name === intent.memberName);
  if (
    !target ||
    target.role !== intent.targetKind ||
    intent.expectedFingerprint !== memberSettingsFingerprint(binding, revision, target.memberId)
  )
    refuse();
  if (
    intent.baseline.length !== state.members.length ||
    new Set(intent.baseline.map((member) => member.memberName)).size !== state.members.length
  )
    refuse();
  for (const member of state.members) {
    const baseline = intent.baseline.find((row) => row.memberName === member.name);
    if (
      !baseline ||
      baseline.expectedFingerprint !== memberSettingsFingerprint(binding, revision, member.memberId)
    )
      refuse();
  }
  const teammates = state.members.filter((member) => member.role === 'member');
  if (
    input.members.length !== teammates.length ||
    new Set(input.members.map((member) => member.name)).size !== teammates.length ||
    teammates.some((member) => !input.members.some((row) => row.name === member.name))
  )
    refuse();
  const settings =
    intent.targetKind === 'lead'
      ? input.savedSettings
      : input.members.find((member) => member.name === intent.memberName);
  if (
    !settings ||
    (settings.model ?? null) !== intent.model ||
    (settings.effort ?? null) !== intent.effort
  )
    refuse();
}
