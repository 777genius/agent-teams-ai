import { assertCapturedRosterCurrent } from './teamRoster.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import type { MemberEntry, HostedTeam } from './MemberEntry.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { MemberActionActor, MemberActionAuthority } from '../team-launch/memberActions.js';

export type NativeMemberActionSource = ReturnType<typeof captureNativeInputAuthority>;
export interface MemberActionAdmission {
  actions: ReturnType<TeamLaunchOwner['memberActions']>;
  journalAuthority: MemberActionAuthority;
  assertCurrent(): void;
  assertRosterCurrent(): void;
  captureTarget(entry: MemberEntry): () => void;
  assertWorkCurrent(entry?: MemberEntry): void;
}
/** Original authenticated native input is a private captured value, never supplied by an MCP payload. */
export function captureNativeMemberActionAdmission(options: {
  team: HostedTeam;
  launch: TeamLaunchOwner;
  source: ReturnType<typeof captureNativeInputAuthority>;
  memberId: string;
  assertCurrent(): void;
  isSealed(): boolean;
}): MemberActionAdmission {
  const { source, team, memberId } = options;
  const actor: MemberActionActor = Object.freeze({
    principalId: source.team.principalId,
    authorityRevision: source.team.authorityRevision,
    inputAuthority: source.fingerprint,
  });
  if (
    !/^[a-f0-9]{64}$/.test(source.fingerprint) ||
    source.team.source.teamId !== team.definition.binding.teamId ||
    source.team.source.backendId !== team.definition.binding.backendId
  )
    throw new RuntimeOwnerError('forbidden');
  const assertBase = () => {
    options.assertCurrent();
    if (options.isSealed()) throw new RuntimeOwnerError('hold');
  };
  const authorized = <T>(action: 'read' | 'control', fn: () => T) => {
    assertBase();
    return team.owner.withNativeMemberActionAuthority(
      {
        proof: source.team,
        target: { memberId },
        action,
        assertSourceTeam: source.assertTeamCurrent,
      },
      fn
    );
  };
  const assertCurrent = () => {
    assertBase();
    source.assertCurrent();
    authorized('control', () => {});
  };
  const actions = options.launch.memberActions({ authorized, captureActor: () => actor });
  // Current source is mandatory on new admission, but retained original lookup is metadata-only.
  authorized('read', () => {});
  return {
    actions,
    assertCurrent,
    assertRosterCurrent: () => assertCapturedRosterCurrent(team, source.team.principalId),
    journalAuthority: { authorized, captureActor: () => actor },
    captureTarget(entry) {
      if (entry.team !== team || entry.binding.memberId !== memberId)
        throw new RuntimeOwnerError('forbidden');
      const binding = structuredClone(entry.binding);
      return () => {
        assertCurrent();
        if (runtimeDigest(entry.binding) !== runtimeDigest(binding))
          throw new RuntimeOwnerError('forbidden');
        team.owner.withNativeMemberActionAuthority(
          {
            proof: source.team,
            target: { memberId, binding },
            action: 'control',
            assertSourceTeam: source.assertTeamCurrent,
          },
          () => {}
        );
      };
    },
    assertWorkCurrent(entry) {
      assertCurrent();
      team.owner.withNativeMemberActionAuthority(
        {
          proof: source.team,
          target: { memberId, ...(entry ? { binding: entry.binding } : {}) },
          action: 'work',
          assertSourceTeam: source.assertTeamCurrent,
        },
        () => {}
      );
    },
  };
}
