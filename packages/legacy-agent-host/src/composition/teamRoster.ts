import { teamRosterRevision } from '../team/rosterSchema.js';
import { settledRuntimeInput } from '../runtime/settledRuntimeInput.js';
import { TeamOwnerError } from '../team/contracts.js';
import { memberBinding } from '../team/DeliveryRecovery.js';
import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeLaunchMembers } from './runtimeLaunchMembers.js';
import type { TeamMember } from '../team/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { MemberEntry, HostedTeam } from './MemberEntry.js';
export interface RetainedLaunchInspection {
  team: HostedTeam;
  launch: TeamLaunchOwner;
  entries?: readonly MemberEntry[];
}

/** A static native capture must not silently launch old options after a saved roster edit. */
export function assertCapturedRosterCurrent(team: HostedTeam, principalId?: string): void {
  const capturePrincipal = principalId ?? team.operatorPrincipalId;
  const actor = team.definition.grants.find(row => row.principalId === capturePrincipal)?.memberName;
  const member = team.definition.members.find(row => row.name === actor) ?? team.definition.members.find(row => row.role === 'lead');
  if (capturePrincipal && member && team.owner.nativeRoster.capturedMemberCurrent(capturePrincipal,
    team.configurationRevision ?? teamRosterRevision(team.definition.members, 0, team.definition.savedSettings),
    { memberId: member.memberId, name: member.name, role: member.role,
      ...(member.settings ? { settings: member.settings } : {}), ...(member.delivery ? { delivery: member.delivery } : {}) }, team.definition.savedSettings)) return;

  const selected =
    capturePrincipal === undefined ? undefined : team.owner.runtimeCapture(capturePrincipal);
  if (
    team.configurationRevision !== undefined
      ? !selected || selected.launchId !== team.launchId
      : selected !== undefined
  )
    throw new TeamOwnerError('hold');
  if (
    team.configurationRevision !== undefined
      ? (principalId === undefined ? team.connection : team.owner.connect(principalId)).readRoster()
          .revision !== team.configurationRevision
      : !team.owner.matchesCapturedRoster(team.definition.members, team.definition.savedSettings)
  )
    throw new TeamOwnerError('hold');
}

/** Proves released/offline custody; this function never stops or allocates a provider. */
export function assertRosterEditable(options: {
  members: readonly { memberId: string; delivery?: TeamMember['delivery'] }[];
  entries: readonly MemberEntry[];
  launch: TeamLaunchOwner;
  runtime: RuntimeOwner;
  action?: 'read' | 'control';
}): void {
  const summary = options.launch.read(options.action ?? 'control');
  for (const member of options.members) {
    if (options.launch.memberActions().pending(member.memberId).length)
      throw new TeamOwnerError('hold');
    if (!member.delivery) continue;
    const entry = options.entries.find((entry) => entry.profile.memberId === member.memberId);
    if (!entry || runtimeDigest(entry.binding) !== runtimeDigest(memberBinding(member.delivery)))
      throw new TeamOwnerError('hold');
    const observed = options.runtime.readCapturedSession(entry.binding),
      record = observed.record;
    const attempt = summary.members.find((item) => item.memberId === member.memberId)?.attempt;
    if (!attempt || observed.attached) throw new TeamOwnerError('hold');
    if (!record) {
      if (attempt.claimed) throw new TeamOwnerError('hold');
      continue;
    }
    if (
      record.custody !== 'released' ||
      record.inputs.some((input) => !settledRuntimeInput(input)) ||
      record.interactions.some((item) => item.phase !== 'resolved')
    )
      throw new TeamOwnerError('hold');
    if (record.phase === 'closed') continue;
    if (
      record.phase !== 'unopened' ||
      record.config !== null ||
      record.openFingerprint !== null ||
      record.sealed ||
      attempt.claimed
    )
      throw new TeamOwnerError('hold');
  }
}

function neverStarted(summary: ReturnType<TeamLaunchOwner['read']>): boolean {
  return summary.admission === undefined && summary.startedAtMs === null &&
    summary.members.every(member => !member.attempt.claimed);
}

/** Original Create recovery reads only its own complete capture, never a later Team run. */
export function readCreatedLaunchAdmission(options: {
  selected: RetainedLaunchInspection;
  entries: readonly MemberEntry[];
  runtime: RuntimeOwner;
  commandId: string;
}) {
  const { selected, runtime, commandId } = options;
  if (!selected.team.capture) throw new TeamLaunchError('hold', 'creation-capture-pending');
  const admitted = selected.launch.readOriginalStart(commandId);
  if (admitted) return { launch: admitted };
  const launch = selected.launch.read();
  if (!neverStarted(launch)) throw new TeamLaunchError('hold', 'creation-launch-unresolved');
  const entries = selected.entries ?? options.entries.filter(entry => entry.team === selected.team);
  assertRosterEditable({ members: runtimeLaunchMembers(selected.team, entries), entries,
    launch: selected.launch, runtime, action: 'read' });
  return { launch, partialCreated: true as const };
}

/** A prospective model check is available only before any admission on the current complete capture. */
export function isUnstartedCaptureEditable(options: {
  team: HostedTeam | undefined;
  launch: TeamLaunchOwner | undefined;
  retainedLaunches: ReadonlyMap<string, RetainedLaunchInspection>;
  entries: readonly MemberEntry[];
  runtime: RuntimeOwner;
}): boolean {
  const { team, launch } = options;
  if (!team?.capture || !launch || !neverStarted(launch.read())) return false;
  assertCapturedRosterCurrent(team);
  for (const retained of options.retainedLaunches.values()) {
    if (retained.team.definition.binding.teamId !== team.definition.binding.teamId) continue;
    const entries = retained.entries ?? options.entries.filter(entry => entry.team === retained.team);
    assertRosterEditable({ members: runtimeLaunchMembers(retained.team, entries), entries,
      launch: retained.launch, runtime: options.runtime, action: 'read' });
  }
  return true;
}
