import {
  rosterName,
  rosterRevision,
  rosterRow,
  rosterSavedSettings,
  rosterSettings,
  rosterText,
} from '../rosterValues';

import type { BackendRosterConfiguration, BackendRosterReceipt } from '../../../contracts/roster';

/** Strip private owner records and native bindings before either IPC or HTTP projection. */
export function projectRosterConfiguration(value: unknown): BackendRosterConfiguration {
  const source = rosterRow(value);
  if (
    !Array.isArray(source.members) ||
    source.members.length > 256 ||
    !Array.isArray(source.removedMembers) ||
    source.removedMembers.length > 1024
  )
    throw new Error('Invalid saved roster');
  const members: BackendRosterConfiguration['members'] = Array.from(source.members, (value) => {
    const member = rosterRow(value);
    if (member.role !== 'lead' && member.role !== 'member')
      throw new Error('Invalid canonical role');
    return {
      memberId: rosterName(member.memberId),
      name: rosterName(member.name),
      role: member.role,
      settings: rosterSettings(member.settings, false),
      ...(member.settingsFingerprint === undefined
        ? {}
        : { settingsFingerprint: rosterRevision(member.settingsFingerprint) }),
    };
  });
  const removedMembers = Array.from(source.removedMembers, (value) => {
    const member = rosterRow(value),
      removedAt = rosterText(member.removedAt, 32);
    if (new Date(removedAt).toISOString() !== removedAt) throw new Error('Invalid removal time');
    return {
      memberId: rosterName(member.memberId),
      name: rosterName(member.name),
      removedAt,
      settings: rosterSettings(member.settings, false),
    };
  });
  const result = {
    revision: rosterRevision(source.revision),
    members,
    removedMembers,
    ...(source.savedSettings === undefined
      ? {}
      : { savedSettings: rosterSavedSettings(source.savedSettings, false) }),
  };
  const ids = [...members, ...removedMembers].map((member) => member.memberId);
  if (
    new Set(ids).size !== ids.length ||
    new Set(members.map((member) => member.name.toLowerCase())).size !== members.length ||
    Buffer.byteLength(JSON.stringify(result)) > 512 * 1024
  )
    throw new Error('Invalid saved roster');
  return result;
}

export function projectRosterReceipt(
  value: unknown,
  commandId: string,
  lookup: boolean
): BackendRosterReceipt | null {
  if (value === null && lookup) return null;
  const source = rosterRow(value);
  if (source.commandId !== commandId) throw new Error('Wrong roster intent');
  return { commandId, revision: rosterRevision(source.revision) };
}
