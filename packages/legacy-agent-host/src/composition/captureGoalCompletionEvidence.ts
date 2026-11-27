import { digest } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import { normalizeBinding } from '../runtime/identity.js';
import { capturedWorkspaceIdentity } from './capturedWorkspaceIdentity.js';
import { assertGoalWorkspaceIsolation } from './assertGoalWorkspaceIsolation.js';
import { readGoalProgressEvidence } from './readGoalProgressEvidence.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { GoalInputSource } from '../team/goalContracts.js';

/** Same qualified artifact references before proposal and after original native quiescence. */
export async function captureGoalCompletionEvidence(options: {
  team: HostedTeam;
  entries(): Iterable<MemberEntry>;
  readRuntime: RuntimeOwner['readCapturedSession'];
  ownerStorageRoot: string;
  initialRuntimeMembers?: readonly RuntimeMemberProfile[];
  isCurrent(entry: MemberEntry): boolean;
  assertCurrent(): void;
}): Promise<string> {
  const read = () => {
    options.assertCurrent();
    const entries = [...options.entries()];
    assertGoalWorkspaceIsolation(options.team.definition.binding.teamId, entries, options.isCurrent);
    const goal = options.team.owner.goals.snapshot();
    if (!goal || !['active', 'finalizing'].includes(goal.disposition)) throw new TeamOwnerError('hold');
    const root = options.team.connection.lookup(goal.rootCommandId);
    if (!root || root.goal?.goalId !== goal.goalId || !root.effects.deliveryId)
      throw new TeamOwnerError('hold');
    const expected = new Set([root.effects.deliveryId, ...Object.keys(goal.debits)]);
    const seen = new Set<string>();
    const originals = new Set<string>();
    const groups: { entry: MemberEntry; sources: GoalInputSource[] }[] = [];
    const workspaceIds = new Set<string>();
    for (const entry of entries) {
      if (entry.team.owner !== options.team.owner) continue;
      const record = options.readRuntime(entry.binding).record;
      const sources: GoalInputSource[] = [];
      for (const input of record?.inputs ?? []) {
        if (!expected.has(input.intent.inputId)) continue;
        const association = options.team.owner.goals.association(input.intent);
        if (seen.has(input.intent.inputId) || !association ||
            association.goalId !== goal.goalId || association.revision !== goal.revision ||
            digest(normalizeBinding(input.intent.binding)) !== digest(normalizeBinding(entry.binding)))
          throw new TeamOwnerError('hold');
        seen.add(input.intent.inputId);
        originals.add(digest({ binding: normalizeBinding(entry.binding), inputId: input.intent.inputId }));
        // Exact not-sent/cancelled/rejected inputs have no native effect to fingerprint.
        if (['not-sent', 'cancelled', 'rejected'].includes(input.phase)) continue;
        if (!(input.phase === 'claimed' || input.phase === 'consumed' ||
            input.phase === 'terminal' && input.terminal === 'succeeded')) throw new TeamOwnerError('hold');
        sources.push({ binding: input.intent.binding, inputId: input.intent.inputId,
          operationRef: input.operationRef, inputFingerprint: input.fingerprint });
      }
      if (sources.length) {
        groups.push({ entry, sources });
        workspaceIds.add(capturedWorkspaceIdentity(entry.profile.cwd));
      }
    }
    if (seen.size !== expected.size) throw new TeamOwnerError('hold');
    // An unrelated writer matters only when it shares an actual captured workspace.
    for (const entry of entries) {
      if (!options.isCurrent(entry)) continue;
      const record = options.readRuntime(entry.binding).record;
      if (!(record?.inputs ?? []).some(input =>
        ['claimed', 'consumed', 'unknown'].includes(input.phase) &&
        !originals.has(digest({ binding: normalizeBinding(entry.binding), inputId: input.intent.inputId })))) continue;
      if (workspaceIds.has(capturedWorkspaceIdentity(entry.profile.cwd))) throw new TeamOwnerError('hold');
    }
    return { groups, witness: digest({ goalId: goal.goalId, revision: goal.revision,
      disposition: goal.disposition, rootCommandId: goal.rootCommandId, debits: goal.debits,
      sources: groups.map(group => group.sources) }) };
  };
  try {
    const captured = read();
    const assertCurrent = () => {
      if (read().witness !== captured.witness) throw new TeamOwnerError('hold');
    };
    const refs: string[] = [];
    for (const { entry, sources } of captured.groups) {
      refs.push(...await readGoalProgressEvidence({ entry, source: sources[0]!,
        additionalSources: sources.slice(1), allowActive: true,
        ownerStorageRoot: options.ownerStorageRoot, readRuntime: options.readRuntime, assertCurrent,
        ...(options.initialRuntimeMembers ? { initialRuntimeMembers: options.initialRuntimeMembers } : {}),
      }));
    }
    assertCurrent();
    return digest([...new Set(refs)].sort());
  } catch { throw new TeamOwnerError('hold'); }
}
