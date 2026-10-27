import { TeamOwnerError } from './contracts.js';
import { digest, safeSegment } from './identity.js';
import { validateTeamText } from './validateTeamCommand.js';
import { memberSettingsSchema, savedTeamSettingsSchema } from './rosterSchema.js';
import type { OwnerState } from './ownerState.js';
import type { TeamOwnerOptions } from './TeamOwner.js';

/** Existing synchronous bootstrap policy; reopened state is never rebuilt from caller options. */
export function initializeTeamOwner(
  options: Pick<
    TeamOwnerOptions,
    'store' | 'binding' | 'members' | 'removedMembers' | 'grants' | 'savedSettings'
  >,
  finishBootstrap: (state: OwnerState) => void
): void {
  options.store.fenced(() => {
    const current = options.store.read<OwnerState>('state.json');
    if (current) {
      if (digest(current.binding) !== digest(options.binding)) throw new TeamOwnerError('conflict');
      if (!current.ready) finishBootstrap(current);
      return;
    }
    for (const member of options.members) {
      safeSegment(member.name);
      safeSegment(member.memberId);
      if (!memberSettingsSchema.safeParse(member.settings ?? {}).success)
        throw new TeamOwnerError('invalid');
      if (
        member.delivery &&
        (digest({
          backendId: member.delivery.backendId,
          teamId: member.delivery.teamId,
          teamName: member.delivery.teamName,
        }) !== digest(options.binding) ||
          member.delivery.memberId !== member.memberId)
      )
        throw new TeamOwnerError('invalid');
    }
    if (
      new Set(options.members.map((member) => member.name.toLowerCase())).size !==
      options.members.length
    )
      throw new TeamOwnerError('invalid');
    const removed = options.removedMembers;
    if (removed !== undefined) {
      if (!Array.isArray(removed) || removed.length > 1024) throw new TeamOwnerError('invalid');
      const all = [...options.members, ...removed];
      if (
        new Set(all.map((member) => member.memberId)).size !== all.length ||
        new Set(all.map((member) => member.name.toLowerCase())).size !== all.length
      )
        throw new TeamOwnerError('invalid');
      for (const member of removed) {
        safeSegment(member.name);
        safeSegment(member.memberId);
        if (
          member.role !== 'member' ||
          member.delivery !== undefined ||
          !memberSettingsSchema.safeParse(member.settings ?? {}).success ||
          typeof member.removedAt !== 'string' ||
          !Number.isFinite(Date.parse(member.removedAt))
        )
          throw new TeamOwnerError('invalid');
      }
    }
    for (const grant of options.grants) {
      validateTeamText(grant.principalId);
      if (
        grant.memberName !== 'user' &&
        !options.members.some((member) => member.name === grant.memberName)
      )
        throw new TeamOwnerError('invalid');
    }
    if (options.store.read('../config.json') !== undefined) throw new TeamOwnerError('conflict');
    const savedSettings =
      options.savedSettings === undefined
        ? undefined
        : savedTeamSettingsSchema.safeParse(options.savedSettings);
    if (savedSettings && !savedSettings.success) throw new TeamOwnerError('invalid');
    const state: OwnerState = {
      schemaVersion: 1,
      binding: options.binding,
      members: options.members,
      ...(removed === undefined ? {} : { removedMembers: structuredClone(removed) }),
      grants: options.grants.map((grant) => ({ ...grant, revision: grant.revision ?? 1 })),
      ready: false,
      ...(!options.members.some((member) => member.delivery)
        ? { runtimeNeverLaunched: true as const }
        : {}),
      ...(savedSettings?.success ? { savedSettings: savedSettings.data } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) throw new TeamOwnerError('invalid');
    options.store.write('state.json', state);
    finishBootstrap(state);
  });
}
