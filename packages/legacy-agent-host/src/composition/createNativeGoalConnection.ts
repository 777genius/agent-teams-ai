import { captureOriginalNativeInput } from './captureNativeInputAuthority.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamMcpConnection } from '../mcp/contracts.js';
import type { WorkSyncTeamProof } from '../work-sync/commandContracts.js';
import type { GoalInputSource } from '../team/goalContracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { captureGoalCompletionEvidence } from './captureGoalCompletionEvidence.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';

/** Goal-only authority never becomes native helper DO authority. Captured once per tool call. */
export function createNativeGoalConnection(options: {
  entry: MemberEntry;
  profileId: string;
  hostIncarnation: string;
  config: MemberEntry['config'];
  entries: ReadonlyMap<string, MemberEntry>;
  ownerStorageRoot: string;
  initialRuntimeMembers?: readonly RuntimeMemberProfile[];
  isCurrent(entry: MemberEntry): boolean;
  readRuntime: RuntimeOwner['readCapturedSession'];
  assertCurrent(): void;
  onProgress(): void;
}) {
  const { entry } = options, owner = entry.team.owner, principalId = entry.profile.principalId;
  const ordinary = owner.connect(principalId);
  const captureWorkSync = () => captureOriginalNativeInput<WorkSyncTeamProof>({
    binding: entry.binding, profileId: options.profileId, hostIncarnation: options.hostIncarnation,
    config: options.config, readRuntime: () => options.readRuntime(entry.binding),
    captureTeam: raw => owner.goals.association(raw)
      ? owner.goals.captureWorkSyncProof(principalId, raw)
      : owner.captureNativeMcpAuthority(principalId, entry.delivery, raw, false),
    assertCurrent: options.assertCurrent,
  });
  const captureGoal = (): GoalInputSource => {
    const captured = captureWorkSync();
    if (captured.team.mode !== 'goal') throw new TeamOwnerError('forbidden');
    captured.assertCurrent();
    return { binding: captured.team.source, inputId: captured.original.inputId,
      operationRef: captured.original.operationRef, inputFingerprint: captured.original.fingerprint };
  };
  const execute: TeamMcpConnection['execute'] = (command, cost, nudge) => {
    options.assertCurrent();
    try {
      const record = options.readRuntime(entry.binding).record;
      const active = record?.inputs.filter(input => input.phase === 'claimed' || input.phase === 'consumed') ?? [];
      if (active.length === 1 && owner.goals.association(active[0]!.intent))
        return owner.executeGoalCommand(principalId, command, { source: captureGoal() });
      return ordinary.execute(command, cost, nudge);
    } finally { options.onProgress(); }
  };
  const goals: NonNullable<TeamMcpConnection['goals']> = {
    status: () => {
      options.assertCurrent();
      const status = owner.goals.publicStatus(principalId);
      return status ? { ...status, objective: owner.goals.objective() } : null;
    },
    propose: async request => {
      const captured = captureWorkSync();
      if (captured.team.mode !== 'goal' || captured.team.role !== 'lead') throw new TeamOwnerError('forbidden');
      const source: GoalInputSource = { binding: captured.team.source, inputId: captured.original.inputId,
        operationRef: captured.original.operationRef, inputFingerprint: captured.original.fingerprint };
      const evidence = await captureGoalCompletionEvidence({ team: entry.team, entries: () => options.entries.values(),
        readRuntime: options.readRuntime, ownerStorageRoot: options.ownerStorageRoot,
        ...(options.initialRuntimeMembers ? { initialRuntimeMembers: options.initialRuntimeMembers } : {}),
        isCurrent: options.isCurrent, assertCurrent: captured.assertCurrent });
      captured.assertCurrent();
      return owner.goals.propose(principalId, source, request, evidence);
    },
  };
  return { execute, goals, captureWorkSync,
    captureWorkSyncTeam: (raw: Parameters<typeof owner.captureNativeMcpAuthority>[2]) =>
      owner.goals.association(raw) ? owner.goals.captureWorkSyncProof(principalId, raw)
        : owner.captureNativeMcpAuthority(principalId, entry.delivery, raw, false) };
}
