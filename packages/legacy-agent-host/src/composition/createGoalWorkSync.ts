import { RuntimeOwnerError } from '../runtime/contracts.js';
import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import { decideGoalContinuation } from '../work-sync/policy/core/domain/GoalContinuationPolicy.js';
import { resolveGoalWaitObserver } from '../work-sync/policy/core/domain/GoalWaitPolicy.js';
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
  onProgress(): void;
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
      assertGoalWorkspaceIsolation(teamId, options.entries.values(), options.isCurrent, options.readRuntime);
      const roster = entries[0]!.team.connection.readRoster().members;
      return roster.every(member => entries.some(entry => entry.binding.memberId === member.memberId)) &&
        roster.some(member => member.role === 'lead');
    } catch { return false; }
  }

  function available(teamId: string): boolean {
    if (!runtimeReady(teamId)) return false;
    return teamEntries(teamId)[0]!.team.owner.goals.canStart();
  }

  function authorizeWorkspace(entry: MemberEntry, intent: ImmutableDelivery,
    readMemberHistory?: () => readonly RuntimeSessionRecord[]): boolean {
    if (!entry.team.owner.goals.association(intent) || entry.team.owner.goals.humanTaskStart(intent)) return true;
    try {
      const goal = entry.team.owner.goals.snapshot();
      if (!goal || !readMemberHistory || !originalGoalLead(entry, goal, readMemberHistory)) return false;
      assertGoalWorkspaceIsolation(entry.binding.teamId, options.entries.values(), options.isCurrent, options.readRuntime);
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
    return !!goal && entries.every(entry => entry.binding.runId === goal.rootBinding.runId) &&
      entries.some(entry => entry.binding.memberId === goal.rootBinding.memberId && originalGoalLead(entry, goal));
  }

  function originalGoalLead(entry: MemberEntry, goal: GoalRecord,
    readMemberHistory?: () => readonly RuntimeSessionRecord[]): boolean {
    if (entry.binding.memberId !== goal.rootBinding.memberId) return true;
    if (runtimeDigest(normalizeBinding(entry.binding)) ===
        runtimeDigest(normalizeBinding(goal.rootBinding))) return true;
    try {
      const history = readMemberHistory?.();
      const record = history ? history.find(row => runtimeDigest(normalizeBinding(row.binding)) ===
        runtimeDigest(normalizeBinding(entry.binding))) : options.readRuntime(entry.binding).record;
      for (const original of restoredMemberRecords(entry, record, goal.rootPrincipalId, history))
        if (runtimeDigest(normalizeBinding(original.binding)) === runtimeDigest(normalizeBinding(goal.rootBinding))) return true;
    } catch { /* Missing or unproven restore ancestry keeps automatic work unavailable. */ }
    return false;
  }

  function records(team: HostedTeam): RuntimeSessionRecord[] {
    const bindings = [...team.owner.goals.inputBindings().values(),
      ...teamEntries(team.definition.binding.teamId).map(entry => entry.binding)];
    return [...new Map(bindings.map(binding => [runtimeDigest(normalizeBinding(binding)), binding])).values()]
      .flatMap(binding => {
        const record = options.readRuntime(binding).record;
        return record ? [record] : [];
      });
  }

  /** Walk proved Restore ancestry; callers stop as soon as their required original is found. */
  function* restoredMemberRecords(entry: MemberEntry, record: RuntimeSessionRecord | undefined,
    principalId: string, history?: readonly RuntimeSessionRecord[]): Generator<RuntimeSessionRecord, void> {
    const seen = new Set<string>();
    let selected = record;
    while (selected) {
      const key = runtimeDigest(normalizeBinding(selected.binding));
      if (seen.has(key)) throw new TeamOwnerError('hold');
      seen.add(key);
      yield selected;
      const restored = selected.restoredFrom;
      if (!restored) return;
      const originalBinding = normalizeBinding(restored.sourceBinding);
      if (selected.config?.checkpointRef !== restored.reference ||
          runtimeDigest({ ...originalBinding, generation: entry.binding.generation }) !== runtimeDigest(normalizeBinding(entry.binding)) ||
          !entry.team.owner.authorizeRuntimeAccess(principalId, originalBinding, 'read')) throw new TeamOwnerError('hold');
      const original = history ? history.find(row => runtimeDigest(normalizeBinding(row.binding)) ===
        runtimeDigest(originalBinding)) : options.readRuntime(originalBinding).record;
      if (!original || original.phase !== 'closed' || original.custody !== 'released' ||
          runtimeDigest(normalizeBinding(original.binding)) !== runtimeDigest(originalBinding)) throw new TeamOwnerError('hold');
      selected = original;
    }
  }

  function settledMemberSource(entry: MemberEntry, record: RuntimeSessionRecord,
    principalId: string, matching: (input: RuntimeInput) => boolean): RuntimeInput | undefined {
    for (const selected of restoredMemberRecords(entry, record, principalId)) {
      const inputs = selected.inputs.filter(matching), latest = inputs.at(-1);
      if (inputs.some(input => ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase)) ||
          latest?.phase === 'terminal' && latest.terminal !== 'succeeded') throw new TeamOwnerError('hold');
      const source = [...inputs].reverse().find(input => input.phase === 'terminal' && input.terminal === 'succeeded');
      if (source) return source;
    }
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
    try { assertGoalWorkspaceIsolation(team.definition.binding.teamId, options.entries.values(), options.isCurrent, options.readRuntime); }
    catch { goals.markAttention('Automatic work requires a separate workspace from other active teams.'); return; }
    const originalGoal = goal;
    let currentRecords = records(team);
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
        currentRecords = records(team);
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
      if (!originalGoalLead(entry, goal)) {
        attention ??= 'Automatic work needs the original lead or its validated Restore successor.'; continue;
      }
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
      let sourceInput: RuntimeInput | undefined;
      try {
        sourceInput = settledMemberSource(entry, record, goal.rootPrincipalId, matching) ??
          currentRecords.flatMap(row => row.inputs).find(input => matching(input) && input.phase === 'terminal' && input.terminal === 'succeeded');
      } catch { attention ??= 'A restored member needs the original settled input evidence before continuing.'; continue; }
      if (!sourceInput) continue;
      const source: GoalInputSource = { binding: normalizeBinding(sourceInput.intent.binding),
        inputId: sourceInput.intent.inputId, operationRef: sourceInput.operationRef, inputFingerprint: sourceInput.fingerprint };
      const assertCurrent = () => {
        options.assertWriter();
        const current = goals.snapshot();
        if (options.isSealed() || !options.isCurrent(entry) || !current || current.disposition !== 'active' ||
            current.goalId !== originalGoal.goalId || current.revision !== originalGoal.revision)
          throw new TeamOwnerError('hold');
      };
      const readDecisionInput = (evidence: readonly string[] = []): GoalWorkDecisionInput | undefined => {
        assertCurrent();
        if (!ready(entry) || !originalGoalLead(entry, goal!)) return undefined;
        // Runtime is read outside the Team fence; no await separates this projection from its decision.
        currentRecords = records(team);
        const latest = currentRecords.find(row => runtimeDigest(normalizeBinding(row.binding)) ===
          runtimeDigest(normalizeBinding(entry.binding)));
        if (!latest || latest.inputs.some(input => ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase)) ||
            latest.interactions.some(interaction => ['pending', 'responding', 'unknown'].includes(interaction.phase)))
          return undefined;
        const latestOwned = latest.inputs.filter(matching).at(-1);
        if (latestOwned?.phase === 'terminal' && latestOwned.terminal !== 'succeeded') return undefined;
        const latestSuccess = [...latest.inputs].reverse().find(input => matching(input) &&
          input.phase === 'terminal' && input.terminal === 'succeeded');
        if (latestSuccess && latestSuccess.intent.inputId !== source.inputId) return undefined;
        return team.owner.withLaunchAuthority(goal!.rootPrincipalId, 'read', () => {
          assertCurrent();
          const freshHistory = goals.continuations();
          const memberHistory = freshHistory.filter(row => row.target.memberId === entry.binding.memberId);
          const prior = memberHistory.filter(row => row.source.inputId === source.inputId &&
            row.source.operationRef === source.operationRef).sort((a, b) => a.sequence - b.sequence).at(-1);
          if (prior) {
            const originalTarget = currentRecords.find(row => runtimeDigest(normalizeBinding(row.binding)) ===
              runtimeDigest(normalizeBinding(prior.target)));
            const delivered = originalTarget?.inputs.find(input => input.intent.inputId === prior.inputId);
            // A durable intent still awaiting original admission must never acquire a replacement.
            if (!delivered || !['cancelled', 'rejected', 'not-sent'].includes(delivered.phase)) return undefined;
          }
          const roster = team.connection.readRoster().members;
          const member = roster.find(row => row.memberId === entry.binding.memberId);
          if (!member || !team.connection.readQueries) throw new TeamOwnerError('hold');
          const kanban = readWorkSyncKanbanProjection(team.connection.readQueries.getKanbanState({ strict: true }));
          const scoped = goals.scopedTasks(), requiredTaskIds = new Set(scoped.map(task => task.id));
          const all = new Map([...team.connection.listTasks(), ...scoped].map(task => [task.id, task]));
          const members = roster.map(row => ({ name: row.name,
            agentType: row.role === 'lead' ? 'team-lead' : 'general-purpose' }));
          const tasks = [...all.values()].map(task => ({ ...projectWorkSyncTask(task, kanban.columns[task.id]),
            humanApprovalPending: task.humanApprovalPending === true,
            progressReferences: requiredTaskIds.has(task.id) ? goals.progressEvidence(task.id) : [] }));
          const original = memberHistory.find(row => row.inputId === source.inputId);
          const taskId = original?.obligationKey.startsWith('task:') ? original.obligationKey.split(':')[1] : undefined;
          if (taskId) {
            const task = tasks.find(row => row.id === taskId);
            if (task) task.progressReferences = [...task.progressReferences, ...evidence];
          }
          waits = inspectGoalWaits(goals.workSyncReports(), freshHistory, goal!.deadlineAt);
          waiting = waits.some(wait => wait.pending)
            ? `Waiting for ${waits.filter(wait => wait.pending).map(wait => wait.description).join('; ')}.` : undefined;
          return {
            goalId: goal!.goalId, teamName: team.definition.binding.teamName,
            memberName: member.name, role: member.role, nowMs: Date.now(),
            requiredTaskIds, members, reviewers: kanban.reviewers, tasks, history: memberHistory,
            waits: waits.map(wait => {
              const observer = resolveGoalWaitObserver(wait, tasks, members);
              const awaitingInput = freshHistory.filter(row => row.obligationKey === `wait:${wait.key}`).some(attempt => {
                const input = currentRecords.flatMap(row => row.inputs).find(row => row.intent.inputId === attempt.inputId);
                return !input || ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase);
              });
              return { ...wait, observer, awaitingInput };
            }), hash: runtimeDigest, progressReferences: !taskId && member.role === 'lead' ? evidence : [],
          };
        });
      };
      let decisionInput = readDecisionInput();
      if (!decisionInput) continue;
      let decision = decideGoalContinuation(decisionInput);
      if ((decision.kind === 'attention' || decision.kind === 'continue' && decision.reason !== 'wait') &&
          runtimeDigest(source.binding) === runtimeDigest(entry.binding)) {
        let evidence: readonly string[];
        try {
          evidence = await readGoalProgressEvidence({ entry, source, ownerStorageRoot: options.ownerStorageRoot,
            ...(options.initialRuntimeMembers ? { initialRuntimeMembers: options.initialRuntimeMembers } : {}),
            readRuntime: options.readRuntime, assertCurrent });
        } catch { attention ??= 'A member needs its original progress evidence before automatic continuation.'; continue; }
        decisionInput = readDecisionInput(evidence);
        if (!decisionInput) continue;
        decision = decideGoalContinuation(decisionInput);
      }
      if (decision.kind !== 'continue') {
        if (decision.kind === 'attention') attention ??= decision.reason;
        else if (decision.kind === 'waiting') waiting ??= decision.reason;
        continue;
      }
      attention ??= decision.attentionReason;
      assertCurrent();
      goals.continue({ target: entry.binding, source, obligationKey: decision.obligationKey,
        evidenceFingerprint: decision.evidenceFingerprint, reason: decision.reason, sequence: decision.sequence,
        text: [`Continue the accepted objective ${goal.goalId}. Continuation ${decision.sequence}. ${decision.instruction}`,
          'Read goal_status if the original criteria are missing from context. Complete one useful step using existing authorized tools; keep scope and approvals unchanged.',
          'Report a real wait or needed clarification through existing tools. Use goal_propose only after verifying the result.'].join('\n') });
      try { await team.owner.resumeDeliveries(options.delivery()); }
      finally { options.onProgress(); }
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
