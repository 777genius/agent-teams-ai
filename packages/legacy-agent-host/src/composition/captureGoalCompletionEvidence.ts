import { digest, safeSegment } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import { normalizeBinding } from '../runtime/identity.js';
import { FileTeamRuntimeBindings } from '../adapters/team/FileTeamRuntimeBindings.js';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { capturedWorkspaceIdentity } from './capturedWorkspaceIdentity.js';
import { assertGoalWorkspaceIsolation, isUnsettledWorkspaceInput, overlapsGoalWorkspace } from './assertGoalWorkspaceIsolation.js';
import { readGoalProgressEvidence } from './readGoalProgressEvidence.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { GoalInputSource } from '../team/goalContracts.js';
import type { GoalEvidenceMember } from './readGoalProgressEvidence.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';

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
    assertGoalWorkspaceIsolation(options.team.definition.binding.teamId, entries, options.isCurrent, options.readRuntime);
    const goal = options.team.owner.goals.snapshot();
    if (!goal || !['active', 'finalizing'].includes(goal.disposition)) throw new TeamOwnerError('hold');
    const root = options.team.connection.lookup(goal.rootCommandId);
    if (!root || root.goal?.goalId !== goal.goalId || !root.effects.deliveryId)
      throw new TeamOwnerError('hold');
    const expected = options.team.owner.goals.inputBindings();
    const seen = new Set<string>();
    const originals = new Set<string>();
    const groups: { entry: GoalEvidenceMember; sources: GoalInputSource[] }[] = [];
    const workspaceIds = new Set<string>();
    const workspacePaths = new Set<string>();
    const bindings = new Map([...expected.values()].map(binding => [digest(normalizeBinding(binding)), binding]));
    for (const binding of bindings.values()) {
      const record = options.readRuntime(binding).record;
      if (!record || digest(normalizeBinding(record.binding)) !== digest(normalizeBinding(binding)))
        throw new TeamOwnerError('hold');
      const sources: GoalInputSource[] = [];
      for (const input of record.inputs) {
        const original = expected.get(input.intent.inputId);
        if (!original) continue;
        const association = options.team.owner.goals.association(input.intent);
        if (seen.has(input.intent.inputId) || !association ||
            association.goalId !== goal.goalId || association.revision !== goal.revision ||
            digest(normalizeBinding(input.intent.binding)) !== digest(normalizeBinding(binding)) ||
            digest(normalizeBinding(original)) !== digest(normalizeBinding(binding)))
          throw new TeamOwnerError('hold');
        seen.add(input.intent.inputId);
        originals.add(digest({ binding: normalizeBinding(binding), inputId: input.intent.inputId }));
        // Exact not-sent/cancelled/rejected inputs have no native effect to fingerprint.
        if (['not-sent', 'cancelled', 'rejected'].includes(input.phase)) continue;
        if (!(input.phase === 'claimed' || input.phase === 'consumed' ||
            input.phase === 'terminal' && ['succeeded', 'failed', 'cancelled'].includes(input.terminal ?? '')))
          throw new TeamOwnerError('hold');
        sources.push({ binding: input.intent.binding, inputId: input.intent.inputId,
          operationRef: input.operationRef, inputFingerprint: input.fingerprint });
      }
      if (sources.length) {
        const entry = originalEvidenceMember(options.team, entries, binding, record, options.ownerStorageRoot);
        groups.push({ entry, sources });
        workspaceIds.add(capturedWorkspaceIdentity(entry.profile.cwd));
        workspacePaths.add(entry.profile.cwd);
      }
    }
    if (seen.size !== expected.size) throw new TeamOwnerError('hold');
    // An unrelated writer matters only when it shares an actual captured workspace.
    for (const entry of entries) {
      const record = options.readRuntime(entry.binding).record;
      if (!(record?.inputs ?? []).some(input =>
        isUnsettledWorkspaceInput(input) &&
        !originals.has(digest({ binding: normalizeBinding(entry.binding), inputId: input.intent.inputId })))) continue;
      if (workspaceIds.has(capturedWorkspaceIdentity(entry.profile.cwd)) ||
          [...workspacePaths].some(path => overlapsGoalWorkspace(path, entry.profile.cwd)))
        throw new TeamOwnerError('hold');
    }
    return { groups, witness: digest({ goalId: goal.goalId, revision: goal.revision,
      disposition: goal.disposition, rootCommandId: goal.rootCommandId, debits: goal.debits, inputs: [...expected],
      sources: groups.map(group => ({ sources: group.sources, config: group.entry.config,
        workspace: capturedWorkspaceIdentity(group.entry.profile.cwd) })) }) };
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

/** Restore changes only the current generation. Original closed Runtime/config remain authoritative. */
function originalEvidenceMember(team: HostedTeam, entries: readonly MemberEntry[], binding: RuntimeBinding,
  record: RuntimeSessionRecord, ownerStorageRoot: string): GoalEvidenceMember {
  const candidates = entries.filter(entry => entry.team.owner === team.owner &&
    (['backendId', 'teamId', 'runId', 'memberId'] as const).every(key => entry.binding[key] === binding[key]));
  const exact = candidates.filter(entry => digest(normalizeBinding(entry.binding)) === digest(normalizeBinding(binding)));
  if (exact.length === 1) return exact[0]!;
  if (exact.length || candidates.length !== 1 || !record.config || record.phase !== 'closed' ||
      record.custody !== 'released') throw new TeamOwnerError('hold');
  const current = candidates[0]!;
  const retained = new FileTeamRuntimeBindings({
    read<T>(name: string, decode?: (text: string) => T): T {
      const path = join(ownerStorageRoot, 'teams', safeSegment(team.definition.binding.teamName), '.host-owner', name);
      const before = lstatSync(path);
      if (!before.isFile() || before.size > 1024 * 1024 || realpathSync(path) !== path)
        throw new TeamOwnerError('hold');
      const text = readFileSync(path, 'utf8'), after = lstatSync(path);
      if (Buffer.byteLength(text) > 1024 * 1024 || realpathSync(path) !== path ||
          (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).some(key => before[key] !== after[key]))
        throw new TeamOwnerError('hold');
      return decode ? decode(text) : JSON.parse(text) as T;
    },
  });
  const { checkpointRef, ...config } = record.config;
  if (!retained.retained(current.delivery, binding) || record.config.generation >= current.config.generation ||
      checkpointRef !== record.restoredFrom?.reference ||
      digest({ ...config, generation: current.config.generation }) !== digest(current.config))
    throw new TeamOwnerError('hold');
  // The validated original selection chain preserves this workspace/config across generations.
  // Return only evidence metadata; no provider, endpoint, grant or registry publication exists here.
  return { team: current.team, binding: normalizeBinding(binding), config: structuredClone(record.config),
    profile: { cwd: current.profile.cwd, principalId: current.profile.principalId } };
}
