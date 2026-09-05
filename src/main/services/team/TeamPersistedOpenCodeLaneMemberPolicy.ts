import { isLeadMember } from '@shared/utils/leadDetection';

/**
 * The three lane fields `toOpenCodePersistedLaunchMember` stamps on every member
 * it writes - and the only writer that stamps all three. They are the whole
 * discriminator for "this snapshot belongs to a pure-OpenCode member lane", so a
 * Claude/Codex/Gemini lead can never match.
 */
interface PersistedOpenCodeLaneMemberShape {
  name?: unknown;
  providerId?: unknown;
  laneId?: unknown;
  laneKind?: unknown;
  laneOwnerProviderId?: unknown;
}

function isOpenCodeLaneOwned(member: PersistedOpenCodeLaneMemberShape | null | undefined): boolean {
  return member?.providerId === 'opencode' && member.laneOwnerProviderId === 'opencode';
}

export function isPersistedOpenCodePrimaryLaneMember(
  member: PersistedOpenCodeLaneMemberShape | null | undefined
): boolean {
  return (
    isOpenCodeLaneOwned(member) &&
    (member?.laneKind === 'primary' ||
      (member?.laneKind === undefined && member?.laneId === 'primary'))
  );
}

/**
 * The OpenCode aggregate lead. `normalizePersistedLaunchSnapshot` used to drop
 * every lead on read-back, so a team whose lead was dead still reported
 * `teamLaunchState: 'clean_success'` and the lead card had no liveness at all.
 */
export function isPersistedOpenCodePrimaryLaneLeadMember(
  member: PersistedOpenCodeLaneMemberShape | null | undefined
): boolean {
  const name = typeof member?.name === 'string' ? member.name.trim() : '';
  return name.length > 0 && isLeadMember({ name }) && isPersistedOpenCodePrimaryLaneMember(member);
}
