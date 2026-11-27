import { RuntimeOwnerError } from '../runtime/contracts.js';
import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import { decideGoalContinuation } from '../work-sync/policy/core/domain/GoalContinuationPolicy.js';
import { inspectGoalWaits } from '../work-sync/inspectGoalWaits.js';
import { projectWorkSyncTask, readWorkSyncKanbanProjection } from '../work-sync/createNativeMemberWorkSyncAgendaSource.js';
import { readGoalProgressEvidence } from './readGoalProgressEvidence.js';
import { captureGoalCompletionEvidence } from './captureGoalCompletionEvidence.js';
import { assertGoalWorkspaceIsolation } from './assertGoalWorkspaceIsolation.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RuntimeBinding, RuntimeInput, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { ImmutableDelivery, TeamRuntimeDeliveryPort } from '../team/contracts.js';
import type { GoalInputSource, GoalRecord } from '../team/goalContracts.js';
import type { GoalWorkDecisionInput } from '../work-sync/policy/core/domain/GoalContinuationPolicy.js';

/** Existing WorkSync wake/pump drives this small goal reconciliation; all intents remain Team-owned. */
export function createGoalWorkSync(options: {
  entries: ReadonlyMap<string, MemberEntry>;
  ownerStorageRoot: string;
  initialRuntimeMembers?: readonly RuntimeMemberProfile[];
  readRuntime(binding: RuntimeBinding): { record: RuntimeSessionRecord | undefined; attached: boolean };
  delivery(): TeamRuntimeDeliveryPort;
  isCurrent(entry: MemberEntry): boolean;
  isSealed(): boolean;
  assertWriter(): void;
}) {
  const running = new Map<string, Promise<void>>();
  const teamEntries = (teamId: string) => [...options.entries.values()].filter(entry =>
    entry.binding.teamId === teamId && options.isCurrent(entry));

  function ready(entry: MemberEntry): boolean {
    if (options.isSealed() || !options.isCurrent(entry) || !entry.provider?.isReady() ||
        (entry.profile.provider === 'opencode' && entry.profile.nativeGeneration === 'v2')) return false;
    const current = options.readRuntime(entry.binding), record = current.record;
    return !!current.attached && !!record && record.phase === 'allocated' && !record.sealed &&
      record.custody === 'owned' && record.nativeReady && !record.control &&
      runtimeDigest(normalizeBinding(record.binding)) === runtimeDigest(normalizeBinding(entry.binding));
  }

  function runtimeReady(teamId: string): boolean {
    try {
      options.assertWriter();
      const entries = teamEntries(teamId);
      if (!entries.length || !entries.every(ready)) return false;
      assertGoalWorkspaceIsolation(teamId, options.entries.values(), options.isCurrent);
      const roster = entries[0]!.team.connection.readRoster().members;
      return roster.every(member => entries.some(entry => entry.binding.memberId === member.memberId)) &&
        roster.some(member => member.role === 'lead');
    } catch { return false; }
  }

  function available(teamId: string): boolean {
    if (!runtimeReady(teamId)) return false;
    const goal = teamEntries(teamId)[0]!.team.owner.goals.snapshot();
    return !goal || goal.disposition === 'accepted' && goal.published === true;
  }

  function authorizeWorkspace(entry: MemberEntry, intent: ImmutableDelivery): boolean {
    if (!entry.team.owner.goals.association(intent)) return true;
    try {
      assertGoalWorkspaceIsolation(entry.binding.teamId, options.entries.values(), options.isCurrent);
      return true;
    } catch { return false; }
  }

  function intake(teamId: string, recipientName: string): { binding: RuntimeBinding } {
    options.assertWriter();
    if (!available(teamId)) throw new RuntimeOwnerError('hold');
    const entries = teamEntries(teamId), roster = entries[0]!.team.connection.readRoster().members;
    const lead = roster.find(member => member.name === recipientName && member.role === 'lead');
    const entry = entries.find(row => row.binding.memberId === lead?.memberId);
    if (!entry) throw new RuntimeOwnerError('forbidden');
    return { binding: structuredClone(entry.binding) };
  }

  function readyForResume(teamId: string): boolean {
    if (!runtimeReady(teamId)) return false;
    const entries = teamEntries(teamId), goal = entries[0]?.team.owner.goals.snapshot();
    return !!goal && entries.every(entry => entry.binding.runId === goal.rootBinding.runId);
  }

  function records(team: HostedTeam, goal: GoalRecord): RuntimeSessionRecord[] {
    const bindings = [goal.rootBinding, ...Object.values(goal.debits).map(row => row.binding),
      ...teamEntries(team.definition.binding.teamId).map(entry => entry.binding)];
    return [...new Map(bindings.map(binding => [runtimeDigest(normalizeBinding(binding)), binding])).values()]
      .flatMap(binding => {
        const record = options.readRuntime(binding).record;
        return record ? [record] : [];
      });
  }

  async function reconcile(team: HostedTeam): Promise<void> {
    options.assertWriter();
    if (options.isSealed()) return;
    const goals = team.owner.goals;
    let goal = goals.snapshot();
    if (!goal) return;
    await goals.retireObsolete(options.delivery());
    options.assertWriter();
    if (options.isSealed()) return;
    goal = goals.snapshot();
    if (!goal) return;
    try { assertGoalWorkspaceIsolation(team.definition.binding.teamId, options.entries.values(), options.isCurrent); }
    catch { goals.markAttention('Automatic work requires a separate workspace from other active teams.'); return; }
    const originalGoal = goal;
    let currentRecords = records(team, goal);
    const history = goals.continuations();
    let waits = inspectGoalWaits(goals.workSyncReports(), history, goal.deadlineAt);
    const unresolvedInteraction = currentRecords.some(record => record.interactions.some(interaction =>
      ['pending', 'responding', 'unknown'].includes(interaction.phase) && record.inputs.some(input =>
        input.intent.inputId === interaction.inputId && goals.association(input.intent)?.goalId === goal!.goalId)));
    goals.reconcileCandidate(currentRecords, waits.some(wait => wait.pending) || unresolvedInteraction,
      waits.find(wait => !wait.pending && wait.attentionReason)?.attentionReason);
    goal = goals.snapshot();
    if (goal?.disposition === 'finalizing' && goal.proposal && !unresolvedInteraction &&
        !currentRecords.some(record => record.inputs.some(input =>
          ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase) && goals.association(input.intent)?.goalId === goal!.goalId))) {
      const candidate = goal;
      try {
        const artifactFingerprint = await captureGoalCompletionEvidence({ team, entries: () => options.entries.values(),
          ownerStorageRoot: options.ownerStorageRoot,
          ...(options.initialRuntimeMembers ? { initialRuntimeMembers: options.initialRuntimeMembers } : {}),
          readRuntime: options.readRuntime, isCurrent: options.isCurrent, assertCurrent: () => {
            options.assertWriter();
            const current = goals.snapshot();
            if (options.isSealed() || current?.disposition !== 'finalizing' || current.goalId !== candidate.goalId ||
                current.revision !== candidate.revision || current.proposal?.commandId !== candidate.proposal!.commandId)
              throw new TeamOwnerError('hold');
          } });
        currentRecords = records(team, candidate);
        waits = inspectGoalWaits(goals.workSyncReports(), goals.continuations(), candidate.deadlineAt);
        goals.reconcileCandidate(currentRecords, waits.some(wait => wait.pending),
          waits.find(wait => !wait.pending && wait.attentionReason)?.attentionReason, artifactFingerprint);
      } catch { goals.markAttention('Final verification needs the original settled input and artifact evidence.'); }
      goal = goals.snapshot();
    }
    if (!goal || goal.disposition !== 'active') return;
    if (Date.now() >= Date.parse(goal.deadlineAt) || Object.keys(goal.debits).length >= goal.attemptLimit) return;
    const entries = teamEntries(team.definition.binding.teamId);
    if (entries.some(entry => entry.binding.runId !== goal!.rootBinding.runId)) {
      goals.markAttention('Original goal belongs to a different run. Resume its original execution.'); return;
    }
    let attention: string | undefined;
    let waiting = waits.some(wait => wait.pending)
      ? `Waiting for ${waits.filter(wait => wait.pending).map(wait => wait.description).join('; ')}.` : undefined;
    for (const entry of entries) {
      let record: RuntimeSessionRecord;
      try {
        if (!ready(entry)) throw new RuntimeOwnerError('hold');
        record = options.readRuntime(entry.binding).record!;
      } catch { attention ??= 'A required member is not ready. Use its existing runtime controls.'; continue; }
      if (record.inputs.some(input => input.phase === 'unknown') ||
          record.interactions.some(interaction => interaction.phase === 'unknown')) {
        attention ??= 'An input or approval outcome is unknown. Resolve its original runtime evidence before continuing.'; continue;
      }
      if (record.inputs.some(input => ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase)) ||
          record.interactions.some(interaction => ['pending', 'responding', 'unknown'].includes(interaction.phase))) continue;
      const matching = (input: RuntimeInput) => {
        const scope = goals.association(input.intent);
        return scope?.goalId === goal!.goalId && scope.revision === goal!.revision;
      };
      const ownLatest = record.inputs.filter(matching).at(-1);
      if (ownLatest?.phase === 'terminal' && ownLatest.terminal !== 'succeeded') {
        attention ??= 'A goal input failed or was cancelled. Its existing recovery must resolve the original outcome.'; continue;
      }
      const sourceInput = [...record.inputs].reverse().find(input => matching(input) && input.phase === 'terminal' && input.terminal === 'succeeded') ??
        currentRecords.flatMap(row => row.inputs).find(input => matching(input) && input.phase === 'terminal' && input.terminal === 'succeeded');
      if (!sourceInput) continue;
      const source: GoalInputSource = { binding: normalizeBinding(sourceInput.intent.binding),
        inputId: sourceInput.intent.inputId, operationRef: sourceInput.operationRef, inputFingerprint: sourceInput.fingerprint };
      const memberHistory = history.filter(row => row.target.memberId === entry.binding.memberId);
      const prior = memberHistory.filter(row => row.source.inputId === source.inputId &&
        row.source.operationRef === source.operationRef).sort((a, b) => a.sequence - b.sequence).at(-1);
      if (prior) {
        const delivered = record.inputs.find(input => input.intent.inputId === prior.inputId);
        // The durable Team intent may still be waiting for original admission. Never mint its replacement.
        if (!delivered || !['cancelled', 'rejected', 'not-sent'].includes(delivered.phase)) continue;
      }
      const assertCurrent = () => {
        options.assertWriter();
        const current = goals.snapshot();
        if (options.isSealed() || !options.isCurrent(entry) || !current || current.disposition !== 'active' ||
            current.goalId !== originalGoal.goalId || current.revision !== originalGoal.revision)
          throw new TeamOwnerError('hold');
      };
      const projection = team.owner.withLaunchAuthority(goal.rootPrincipalId, 'read', () => {
        assertCurrent();
        const roster = team.connection.readRoster().members;
        const member = roster.find(row => row.memberId === entry.binding.memberId);
        if (!member || !team.connection.readQueries) throw new TeamOwnerError('hold');
        const kanban = readWorkSyncKanbanProjection(team.connection.readQueries.getKanbanState({ strict: true }));
        const scoped = goals.scopedTasks(), requiredTaskIds = new Set(scoped.map(task => task.id));
        const all = new Map([...team.connection.listTasks(), ...scoped].map(task => [task.id, task]));
        return { member, requiredTaskIds, members: roster.map(row => ({ name: row.name,
          agentType: row.role === 'lead' ? 'team-lead' : 'general-purpose' })), reviewers: kanban.reviewers,
          tasks: [...all.values()].map(task => ({ ...projectWorkSyncTask(task, kanban.columns[task.id]),
            progressReferences: requiredTaskIds.has(task.id) ? goals.progressEvidence(task.id) : [] })) };
      });
      const decisionInput: GoalWorkDecisionInput = {
        ...projection, goalId: goal.goalId, teamName: team.definition.binding.teamName,
        memberName: projection.member.name, role: projection.member.role, nowMs: Date.now(),
        history: memberHistory, waits: waits.map(wait => {
          const owners = [...wait.taskIds].sort().flatMap(id => {
            const owner = projection.tasks.find(task => task.id === id)?.owner;
            return owner && projection.members.some(member => member.name === owner) ? [owner] : [];
          });
          const observer = owners.includes(wait.observer) ? wait.observer : owners[0] ??
            (projection.members.some(member => member.name === wait.observer) ? wait.observer :
              projection.members.find(member => member.agentType === 'team-lead')?.name ?? wait.observer);
          const awaitingInput = history.filter(row => row.obligationKey === `wait:${wait.key}`).some(attempt => {
            const input = currentRecords.flatMap(row => row.inputs).find(row => row.intent.inputId === attempt.inputId);
            return !input || ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase);
          });
          return { ...wait, observer, awaitingInput };
        }), hash: runtimeDigest, progressReferences: [],
      };
      let decision = decideGoalContinuation(decisionInput);
      if ((decision.kind === 'attention' || decision.kind === 'continue' && decision.reason !== 'wait') &&
          runtimeDigest(source.binding) === runtimeDigest(entry.binding)) {
        let evidence: readonly string[];
        try {
          evidence = await readGoalProgressEvidence({ entry, source, ownerStorageRoot: options.ownerStorageRoot,
            ...(options.initialRuntimeMembers ? { initialRuntimeMembers: options.initialRuntimeMembers } : {}),
            readRuntime: options.readRuntime, assertCurrent });
        } catch { attention ??= 'A member needs its original progress evidence before automatic continuation.'; continue; }
        assertCurrent();
        const original = memberHistory.find(row => row.inputId === source.inputId);
        const taskId = original?.obligationKey.startsWith('task:') ? original.obligationKey.split(':')[1] : undefined;
        if (taskId) {
          const task = decisionInput.tasks.find(row => row.id === taskId);
          if (task) task.progressReferences = [...task.progressReferences, ...evidence];
        } else if (projection.member.role === 'lead') decisionInput.progressReferences = evidence;
        decision = decideGoalContinuation(decisionInput);
      }
      if (decision.kind !== 'continue') {
        if (decision.kind === 'attention') attention ??= decision.reason;
        else if (decision.kind === 'waiting') waiting ??= decision.reason;
        continue;
      }
      attention ??= decision.attentionReason;
      assertCurrent();
      const latest = options.readRuntime(entry.binding).record;
      if (!latest || latest.inputs.some(input => ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase))) continue;
      goals.continue({ target: entry.binding, source, obligationKey: decision.obligationKey,
        evidenceFingerprint: decision.evidenceFingerprint, reason: decision.reason, sequence: decision.sequence,
        text: [`Continue the accepted objective ${goal.goalId}. ${decision.instruction}`,
          'Read goal_status if the original criteria are missing from context. Complete one useful step using existing authorized tools; keep scope and approvals unchanged.',
          'Report a real wait or needed clarification through existing tools. Use goal_propose only after verifying the result.'].join('\n') });
      await team.owner.resumeDeliveries(options.delivery());
    }
    goals.markAttention(attention ?? waiting);
  }

  return { available, intake, readyForResume, authorizeWorkspace,
    settle(team: HostedTeam): Promise<void> {
      const key = team.definition.binding.teamId, current = running.get(key);
      if (current) return current;
      const pending = reconcile(team).finally(() => { if (running.get(key) === pending) running.delete(key); });
      running.set(key, pending); return pending;
    },
  };
}
