import { deliveryFingerprint } from '../runtime/identity.js';
import type { RuntimeSessionRecord } from '../runtime/contracts.js';
import { TeamOwnerError } from './contracts.js';
import type { CommandReceipt, DeliveryIntent, ImmutableDelivery, RuntimeMemberBinding, TeamCommand, TeamGrant, TeamRuntimeDeliveryPort } from './contracts.js';
import { deliveryIdentity, memberBinding } from './DeliveryRecovery.js';
import { listProductCommandReceipts, listTeamCommandEntries, readProductCommand } from './commandEntries.js';
import { digest, effectId, safeSegment } from './identity.js';
import type { OwnerState } from './ownerState.js';
import type { TeamPolicyPort, TeamStore, TeamTask } from './ports.js';
import type { ExecuteGoalCommand, GoalAssociation, GoalCommandOrigin, GoalCommandPreparation, GoalContinuation, GoalControl, GoalInputSource, GoalProposalRequest, GoalRecord, GoalStatus } from './goalContracts.js';
import { validateGoalControl, validateGoalOptions, validateGoalOrigin, validateGoalRecord, validateGoalSource } from './validateGoal.js';
import { goalTaskFingerprint, proposeGoal, reconcileGoalCandidate } from './goalCompletion.js';
import type { GoalWorkSyncAuthorityProof } from '../work-sync/commandContracts.js';
import type { WorkSyncCommandReceipt } from '../work-sync/commandContracts.js';
import { inspectGoalWaits } from '../work-sync/inspectGoalWaits.js';
import { goalContinuationCurrent } from './goalContinuationCurrent.js';

const expired = (goal: GoalRecord) => goal.deadlineReached === true || Date.now() >= Date.parse(goal.deadlineAt);

/** A bounded objective on the existing Team owner. No delivery queue or Runtime ownership. */
export class TeamGoals {
  constructor(private readonly options: {
    store: TeamStore;
    policy: TeamPolicyPort;
    state(): OwnerState;
    authorize(principalId: string, permission: TeamGrant['permissions'][number]): TeamGrant;
    authorizeDelivery(raw: ImmutableDelivery, action: 'read' | 'admit' | 'dispatch' | 'control'): boolean;
    humanTaskStart(intent: DeliveryIntent, receipt: CommandReceipt): boolean;
    execute: ExecuteGoalCommand;
    invalidate(): void;
  }) {}

  private state(): OwnerState {
    this.options.state();
    const state = this.options.store.read<OwnerState>('state.json');
    if (!state?.ready) throw new TeamOwnerError('hold');
    if (state.autonomousGoal) {
      validateGoalRecord(state.autonomousGoal);
      if (!state.autonomousGoal.deadlineReached && expired(state.autonomousGoal)) {
        state.autonomousGoal.deadlineReached = true;
        this.options.store.write('state.json', state);
        this.options.invalidate();
      }
    }
    return state;
  }

  private save(goal: GoalRecord): void {
    if (Date.now() >= Date.parse(goal.deadlineAt)) goal.deadlineReached = true;
    validateGoalRecord(goal);
    this.options.store.write('state.json', { ...this.state(), autonomousGoal: goal });
    this.options.invalidate();
  }

  snapshot(): GoalRecord | undefined {
    return this.options.store.fenced(() => structuredClone(this.state().autonomousGoal));
  }

  canStart(): boolean {
    try {
      return this.options.store.fenced(() => {
        const goal = this.state().autonomousGoal;
        return (!goal || goal.disposition === 'accepted' && goal.published === true) &&
          !listProductCommandReceipts(this.options.store).some(receipt => receipt.goal?.kind === 'intake' &&
            !['completed', 'rejected'].includes(receipt.phase));
      });
    } catch { return false; } // Unreadable original receipts close new goal admission, not ordinary reads.
  }

  /** Continue original message receipts after interrupted intake/result publication, never recapture. */
  resumeCommands(): void {
    let receipts: CommandReceipt[];
    try { receipts = this.options.store.fenced(() => listProductCommandReceipts(this.options.store)); }
    catch { return; } // Keep malformed originals held without preventing ordinary owner startup.
    for (const receipt of receipts) {
      if (!receipt.goal || receipt.command.operation !== 'message.send' ||
          ['completed', 'rejected'].includes(receipt.phase)) continue;
      try { this.options.execute(receipt.principalId, receipt.command); }
      catch { /* Preserve the original command for later authenticated recovery. */ }
    }
  }

  publicStatus(principalId: string): GoalStatus | undefined {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const goal = this.state().autonomousGoal;
      return goal && this.status(goal);
    });
  }

  private status(goal: GoalRecord): GoalStatus {
    const elapsed = expired(goal);
    const used = Object.keys(goal.debits).length;
    const reason = goal.disposition === 'active' && elapsed ? 'deadline-reached' :
      goal.disposition === 'active' && used >= goal.attemptLimit ? 'attempt-limit-reached' : goal.reason;
    return {
      goalId: goal.goalId, revision: goal.revision, disposition: goal.disposition,
      startedAt: goal.startedAt, deadlineAt: goal.deadlineAt,
      attemptLimit: goal.attemptLimit, attemptsUsed: used,
      ...(reason ? { reason } : {}),
      ...(goal.disposition === 'accepted' && goal.proposal
        ? { resultMessageId: goal.proposal.resultMessageId, published: goal.published === true } : {}),
      ...(goal.disposition === 'stopped' && !elapsed && used < goal.attemptLimit ? { canResume: true } : {}),
    };
  }

  objective(): string {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal) return '';
      const receipt = readProductCommand(this.options.store, goal.rootCommandId);
      if (receipt?.command.operation !== 'message.send' || receipt.goal?.goalId !== goal.goalId)
        throw new TeamOwnerError('hold');
      return receipt.command.payload.text;
    });
  }

  /** Immutable original association remains readable after expiry, Stop or finalization. */
  association(raw: ImmutableDelivery): GoalAssociation | undefined {
    return this.options.store.fenced(() => {
      safeSegment(raw.deliveryId);
      const intent = this.options.store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`);
      if (!intent || digest(deliveryIdentity(raw)) !== digest(deliveryIdentity(intent))) return undefined;
      const receipt = readProductCommand(this.options.store, intent.commandId);
      const origin = receipt?.goal;
      if (!origin || receipt.phase === 'rejected') return undefined;
      validateGoalOrigin(origin);
      return { goalId: origin.goalId, revision: origin.revision };
    });
  }

  /** Original human authority is distinct from the retained Goal evidence association. */
  humanTaskStart(raw: ImmutableDelivery): boolean {
    return this.options.store.fenced(() => {
      if (!this.association(raw)) return false;
      const intent = this.options.store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`)!;
      return this.options.humanTaskStart(intent, readProductCommand(this.options.store, intent.commandId)!);
    });
  }

  /** Derive required originals without charging or forgetting separately authorized human work. */
  inputBindings(): ReadonlyMap<string, RuntimeMemberBinding> {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal) return new Map();
      const root = readProductCommand(this.options.store, goal.rootCommandId);
      if (!root || root.goal?.goalId !== goal.goalId || root.goal.revision !== goal.revision || !root.effects.deliveryId)
        throw new TeamOwnerError('hold');
      const inputs = new Map([[root.effects.deliveryId, memberBinding(goal.rootBinding)],
        ...Object.entries(goal.debits).map(([id, debit]) => [id, memberBinding(debit.binding)] as const)]);
      for (const intent of this.options.store.list<DeliveryIntent>('outbox')) {
        const association = this.association(intent);
        if (association?.goalId !== goal.goalId || association.revision !== goal.revision || !this.humanTaskStart(intent)) continue;
        const previous = inputs.get(intent.inputId), binding = memberBinding(intent.binding);
        if (previous && digest(previous) !== digest(binding)) throw new TeamOwnerError('hold');
        inputs.set(intent.inputId, binding);
      }
      return new Map([...inputs].sort(([a], [b]) => a.localeCompare(b)));
    });
  }

  private sourceAssociation(source: GoalInputSource): GoalAssociation {
    validateGoalSource(source);
    const intent = this.options.store.read<DeliveryIntent>(`outbox/${source.inputId}.json`);
    if (!intent || digest(memberBinding(intent.binding)) !== digest(memberBinding(source.binding)) ||
        deliveryFingerprint(intent) !== source.inputFingerprint) throw new TeamOwnerError('forbidden');
    const association = this.association(intent), goal = this.state().autonomousGoal;
    if (!association || !goal || association.goalId !== goal.goalId || association.revision !== goal.revision)
      throw new TeamOwnerError('forbidden');
    return association;
  }

  captureWorkSyncProof(principalId: string, raw: ImmutableDelivery): GoalWorkSyncAuthorityProof {
    return this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId, 'task.write');
      const member = this.options.state().members.find(row => row.memberId === raw.binding.memberId);
      const association = this.association(raw), goal = this.state().autonomousGoal;
      if (!association || !goal || association.goalId !== goal.goalId || association.revision !== goal.revision ||
          !member?.delivery || member.name !== grant.memberName ||
          digest(memberBinding(member.delivery)) !== digest(memberBinding(raw.binding))) throw new TeamOwnerError('forbidden');
      const value = { principalId, authorityRevision: grant.revision ?? 1, actorId: member.memberId,
        memberName: member.name, role: member.role, source: memberBinding(raw.binding),
        original: { inputId: raw.inputId, deliveryId: raw.deliveryId, messageId: raw.messageId },
        mode: 'goal' as const, goal: association };
      return Object.freeze({ ...value, fingerprint: digest({ ...value, delivery: deliveryIdentity(raw) }) });
    });
  }

  /** Called only by the native wrapper, with a Runtime-captured original source. */
  assertSource(principalId: string, source: GoalInputSource, requireLead = false): GoalAssociation {
    return this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId, 'task.write');
      const member = this.options.state().members.find(row => row.memberId === source.binding.memberId);
      if (!member?.delivery || member.name !== grant.memberName || grant.memberName === 'user' ||
          (requireLead && member.role !== 'lead') ||
          digest(memberBinding(member.delivery)) !== digest(memberBinding(source.binding)))
        throw new TeamOwnerError('forbidden');
      return this.sourceAssociation(source);
    });
  }

  /** Command preparation and its receipt publication share Team's existing synchronous fence. */
  prepare(principalId: string, command: TeamCommand, delivery: RuntimeMemberBinding | undefined,
    preparation?: GoalCommandPreparation): GoalCommandOrigin | undefined {
    const grant = this.options.authorize(principalId, 'read');
    if (command.operation === 'message.send' && command.payload.autonomousGoal) {
      validateGoalOptions(command.payload.autonomousGoal);
      if (grant.memberName !== 'user' || !grant.permissions.includes('admin') ||
          (command.payload.actionMode !== 'do' && command.payload.actionMode !== 'delegate') || command.payload.nativeCommand ||
          !delivery || !preparation?.intake ||
          digest(memberBinding(preparation.intake.binding)) !== digest(memberBinding(delivery)) ||
          this.options.state().members.find(row => row.name === command.payload.to)?.role !== 'lead')
        throw new TeamOwnerError('forbidden');
      const old = this.state().autonomousGoal;
      const goalId = effectId('goal', this.options.state().binding.teamId, command.commandId);
      if (old && old.goalId !== goalId && !(old.disposition === 'accepted' && old.published))
        throw new TeamOwnerError('conflict');
      if (!this.canStart()) throw new TeamOwnerError('hold');
      return { goalId, revision: 1, kind: 'intake' };
    }
    if (preparation?.result) {
      const goal = this.state().autonomousGoal;
      if (!goal || goal.disposition !== 'accepted' || !goal.proposal ||
          goal.goalId !== preparation.result.goalId || goal.revision !== preparation.result.revision ||
          principalId !== goal.proposal.principalId || command.operation !== 'message.send' ||
          command.payload.to !== 'user' || command.commandId !== goal.proposal.resultMessageId ||
          command.payload.text !== goal.proposal.result)
        throw new TeamOwnerError('forbidden');
      return { ...preparation.result, kind: 'result' };
    }
    if (preparation?.source || preparation?.continuation) {
      const source = preparation.source ?? preparation.continuation!.source;
      const association = preparation.continuation ? this.sourceAssociation(source) : this.assertSource(principalId, source);
      if (preparation.continuation) {
        const member = this.options.state().members.find(row => row.name === grant.memberName);
        if (!member?.delivery || command.operation !== 'message.send' || command.payload.to !== member.name ||
            digest(memberBinding(member.delivery)) !== digest(memberBinding(preparation.continuation.target)))
          throw new TeamOwnerError('forbidden');
      }
      return { ...association, kind: preparation.continuation ? 'continuation' : 'input', source,
        ...(preparation.continuation ? { continuation: structuredClone(preparation.continuation) } : {}) };
    }
    // Mutating an already scoped task keeps its notification provenance even for human review.
    if ('taskId' in command.payload) {
      const goal = this.state().autonomousGoal;
      if (goal && this.taskIds(goal).has(command.payload.taskId))
        return { goalId: goal.goalId, revision: goal.revision, kind: 'task' };
    }
    return undefined;
  }

  /** Recoverable receipt first, goal second, then original inbox/outbox. No Runtime admission here. */
  acceptReceipt(receipt: CommandReceipt): void {
    if (receipt.goal?.kind !== 'intake') return;
    const command = receipt.command;
    if (command.operation !== 'message.send' || !command.payload.autonomousGoal || !receipt.deliveryBinding)
      throw new TeamOwnerError('hold');
    const current = this.state().autonomousGoal;
    if (current?.goalId === receipt.goal.goalId) return;
    if (current && !(current.disposition === 'accepted' && current.published)) throw new TeamOwnerError('conflict');
    this.save({ goalId: receipt.goal.goalId, revision: receipt.goal.revision,
      rootCommandId: receipt.commandId, rootPrincipalId: receipt.principalId,
      rootBinding: memberBinding(receipt.deliveryBinding), rootMode: command.payload.actionMode === 'delegate' ? 'delegate' : 'do',
      startedAt: receipt.createdAt,
      deadlineAt: new Date(Date.parse(receipt.createdAt) + command.payload.autonomousGoal.durationHours * 3600000).toISOString(),
      attemptLimit: command.payload.autonomousGoal.maxAttempts, disposition: 'active', debits: {} });
  }

  private receipts(goal: GoalRecord): CommandReceipt[] {
    return listProductCommandReceipts(this.options.store).filter(row =>
      row.goal?.goalId === goal.goalId && row.goal.revision === goal.revision && row.phase !== 'rejected');
  }

  private taskIds(goal: GoalRecord): Set<string> {
    return new Set(this.receipts(goal).filter(row => row.command.operation === 'task.create').map(row => row.effects.taskId));
  }

  scopedTasks(): TeamTask[] {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal) return [];
      const board = this.options.policy.taskBoard();
      const kanban = board.getKanbanState({ strict: true }) as { reviewFlow?: string; tasks?: Record<string, { column?: string }> };
      const flow = kanban.reviewFlow ?? 'agent_approval';
      if (!['agent_approval', 'human_approval', 'lead_then_human'].includes(flow)) throw new TeamOwnerError('hold');
      const tasks = new Map([...board.listTasks(), ...board.listDeletedTasks()].map(task => [task.id, task]));
      return [...this.taskIds(goal)].sort().map(id => {
        const task = structuredClone(tasks.get(id) ?? { id, status: 'missing' });
        const column = kanban.tasks?.[id]?.column;
        if (column) task.kanbanColumn = column;
        task.goalReviewFlow = flow;
        task.humanApprovalPending = flow !== 'agent_approval' &&
          !(task.reviewState === 'approved' && task.kanbanColumn === 'approved');
        return task;
      });
    });
  }

  continuations(): (GoalContinuation & { inputId: string; createdAt: string })[] {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      return goal ? this.receipts(goal).flatMap(row => row.goal?.continuation ? [{ ...structuredClone(row.goal.continuation), inputId: row.effects.deliveryId, createdAt: row.createdAt }] : []) : [];
    });
  }

  progressEvidence(taskId?: string): string[] {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal) return [];
      const ids = this.taskIds(goal), refs: string[] = [];
      for (const receipt of this.receipts(goal)) {
        if (receipt.phase !== 'completed' || !('taskId' in receipt.command.payload) ||
            !ids.has(receipt.command.payload.taskId) || (taskId && receipt.command.payload.taskId !== taskId)) continue;
        if (receipt.command.operation === 'task.attachment.add') refs.push(digest(receipt.command.payload.attachment));
        if (receipt.command.operation === 'task.comment') for (const attachment of receipt.command.payload.attachments ?? []) refs.push(digest(attachment));
      }
      for (const task of this.scopedTasks()) {
        if (taskId && task.id !== taskId || !Array.isArray(task.historyEvents)) continue;
        for (const event of task.historyEvents) {
          if (event && typeof event === 'object' && !Array.isArray(event) &&
              ['review_completed', 'review_approved', 'human_approved', 'changes_requested'].includes(String(event.type)))
            refs.push(digest({ taskId: task.id, event }));
        }
      }
      return [...new Set(refs)].sort();
    });
  }

  workSyncReports(): WorkSyncCommandReceipt[] {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal) return [];
      return listTeamCommandEntries(this.options.store).filter((row): row is WorkSyncCommandReceipt =>
        'family' in row && row.family === 'work-sync' && row.operation === 'report' && row.phase === 'completed' &&
        row.nativeInput.team.mode === 'goal' && row.nativeInput.team.goal.goalId === goal.goalId &&
        row.nativeInput.team.goal.revision === goal.revision).map(row => structuredClone(row));
    });
  }

  /** Called under Runtime -> Team. Debit witness and count are one atomic state write. */
  authorizeInput(raw: ImmutableDelivery, action: 'admit' | 'dispatch'): boolean {
    return this.options.store.fenced(() => {
      const association = this.association(raw);
      if (!association) return true;
      if (this.humanTaskStart(raw)) return true;
      const intent = this.options.store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`)!;
      const receipt = readProductCommand(this.options.store, intent.commandId)!;
      const goal = this.state().autonomousGoal;
      if (!goal || goal.goalId !== association.goalId || goal.revision !== association.revision) return false;
      // The original authenticated user submission isn't an automatic attempt.
      if (receipt.goal?.kind === 'intake') return goal.disposition === 'active';
      if (goal.disposition !== 'active' || expired(goal)) return false;
      if (!this.continuationCurrent(receipt, goal)) return false;
      const witness = goal.debits[raw.inputId];
      if (witness) return witness.commandId === intent.commandId && digest(witness.binding) === digest(memberBinding(raw.binding));
      if (action === 'dispatch' || Object.keys(goal.debits).length >= goal.attemptLimit) return false;
      goal.debits[raw.inputId] = { commandId: intent.commandId, binding: memberBinding(raw.binding) };
      this.save(goal);
      return true;
    });
  }

  withDispatchAuthority(raw: ImmutableDelivery, commitClaim: () => void): void {
    this.options.store.fenced(() => {
      if (!this.options.authorizeDelivery(raw, 'dispatch') || !this.authorizeInput(raw, 'dispatch'))
        throw new TeamOwnerError('forbidden');
      const goal = this.state().autonomousGoal;
      // Ordinary human work still runs; its actual claim invalidates a candidate atomically.
      if (goal?.disposition === 'finalizing' && (!this.association(raw) || this.humanTaskStart(raw))) {
        goal.disposition = 'active'; delete goal.proposal; goal.reason = 'verification-changed';
        this.save(goal);
      }
      commitClaim();
    });
  }

  continue(next: GoalContinuation): CommandReceipt {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal || goal.disposition !== 'active' || expired(goal))
        throw new TeamOwnerError('hold');
      const association = this.sourceAssociation(next.source);
      const member = this.options.state().members.find(row => row.memberId === next.target.memberId);
      const principal = this.options.state().grants.find(row => row.memberName === member?.name && !row.revoked && row.permissions.includes('message.write'));
      if (!member?.delivery || !principal || digest(memberBinding(member.delivery)) !== digest(memberBinding(next.target)))
        throw new TeamOwnerError('forbidden');
      const origin: GoalCommandOrigin = { ...association, kind: 'continuation', source: next.source, continuation: next };
      validateGoalOrigin(origin);
      const commandId = effectId('goal-next', goal.goalId, digest({ ...next, text: undefined }));
      const prior = readProductCommand(this.options.store, commandId);
      if (!prior && Object.keys(goal.debits).length >= goal.attemptLimit) throw new TeamOwnerError('hold');
      return this.options.execute(principal.principalId, { commandId, operation: 'message.send',
        payload: { to: member.name, text: next.text, messageId: commandId,
          actionMode: member.role === 'lead' ? goal.rootMode : 'do' } }, { continuation: next });
    });
  }

  markAttention(reason?: string): void {
    reason = reason?.slice(0, 512);
    this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal || goal.reason === reason || goal.disposition === 'accepted' || goal.disposition === 'stopped') return;
      if (reason === undefined) delete goal.reason;
      else goal.reason = reason;
      this.save(goal);
    });
  }

  control(principalId: string, control: GoalControl, ready = false): GoalStatus {
    validateGoalControl(control);
    return this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId, 'admin');
      if (grant.memberName !== 'user') throw new TeamOwnerError('forbidden');
      const goal = this.state().autonomousGoal;
      if (!goal || goal.goalId !== control.goalId || goal.revision !== control.expectedRevision)
        throw new TeamOwnerError('conflict');
      const key = digest(control.commandId), fingerprint = digest({ principalId, control });
      const prior = goal.controls?.[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamOwnerError('conflict');
        return structuredClone(prior.result);
      }
      const controlsUsed = Object.keys(goal.controls ?? {}).length;
      if (controlsUsed >= 256 || controlsUsed >= 255 && control.action !== 'stop')
        throw new TeamOwnerError('hold'); // Reserve the last original receipt for stopping automatic work.
      if (control.action === 'stop') {
        if (goal.disposition !== 'accepted') { goal.disposition = 'stopped'; goal.reason = 'stopped-by-user'; }
      } else if (control.action === 'resume') {
        if (!ready || goal.disposition !== 'stopped' || expired(goal) ||
            Object.keys(goal.debits).length >= goal.attemptLimit) throw new TeamOwnerError('hold');
        goal.disposition = 'active'; delete goal.reason; delete goal.proposal;
      } else {
        if (goal.disposition === 'accepted' || (control.deadlineAt === undefined && control.attemptLimit === undefined))
          throw new TeamOwnerError('invalid');
        if (control.deadlineAt !== undefined) {
          if (Date.parse(control.deadlineAt) < Date.parse(goal.deadlineAt) ||
              Date.parse(control.deadlineAt) > Date.now() + 24 * 3600000) throw new TeamOwnerError('invalid');
          if (Date.parse(control.deadlineAt) > Date.parse(goal.deadlineAt) && Date.parse(control.deadlineAt) > Date.now())
            delete goal.deadlineReached;
          goal.deadlineAt = control.deadlineAt;
        }
        if (control.attemptLimit !== undefined) {
          if (control.attemptLimit < goal.attemptLimit) throw new TeamOwnerError('invalid');
          goal.attemptLimit = control.attemptLimit;
        }
      }
      const result = this.status(goal);
      (goal.controls ??= {})[key] = { fingerprint, result };
      this.save(goal);
      return result;
    });
  }

  stopForRuntime(binding: RuntimeMemberBinding, assertAuthority: () => void): void {
    this.options.store.fenced(() => {
      assertAuthority();
      const goal = this.state().autonomousGoal;
      if (!goal || !['active', 'finalizing'].includes(goal.disposition)) return;
      if (!this.options.state().members.some(row => row.delivery && digest(memberBinding(row.delivery)) === digest(memberBinding(binding))))
        throw new TeamOwnerError('forbidden');
      goal.disposition = 'stopped'; goal.reason = 'runtime-stopped'; this.save(goal);
    });
  }

  async retireObsolete(runtime: TeamRuntimeDeliveryPort): Promise<void> {
    if (!runtime.cancelDelivery) return;
    const obsolete = (intent: DeliveryIntent) => {
      const association = this.association(intent), goal = this.state().autonomousGoal;
      if (!association || this.humanTaskStart(intent) || readProductCommand(this.options.store, intent.commandId)?.goal?.kind === 'intake') return false;
      return !goal || association.goalId !== goal.goalId || association.revision !== goal.revision ||
        goal.disposition !== 'active' || expired(goal) ||
        (!goal.debits[intent.inputId] && Object.keys(goal.debits).length >= goal.attemptLimit) ||
        !this.continuationCurrent(readProductCommand(this.options.store, intent.commandId)!, goal);
    };
    const candidates = this.options.store.fenced(() => this.options.store.list<DeliveryIntent>('outbox').filter(obsolete));
    for (const intent of candidates) {
      // Runtime owns claimed/unknown outcomes; cancellation never replays or erases them.
      try {
        await runtime.cancelDelivery(intent, commit => this.options.store.fenced(() => {
          if (!obsolete(intent)) throw new TeamOwnerError('hold');
          commit();
        }));
      } catch { /* Retain original debt; a fresh Resume may have reopened this input. */ }
    }
  }

  propose(principalId: string, source: GoalInputSource, request: GoalProposalRequest, evidenceFingerprint: string): GoalStatus {
    return this.options.store.fenced(() => {
      this.assertSource(principalId, source, true);
      const goal = this.state().autonomousGoal!;
      const key = digest(request.commandId), fingerprint = digest({ principalId, source, request });
      const prior = goal.proposals?.[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamOwnerError('conflict');
        return structuredClone(prior.result);
      }
      if (Object.keys(goal.proposals ?? {}).length >= 256) throw new TeamOwnerError('hold');
      const waits = inspectGoalWaits(this.workSyncReports(), this.continuations(), goal.deadlineAt);
      if (waits.some(wait => wait.pending || wait.attentionReason)) throw new TeamOwnerError('hold');
      const grant = this.options.authorize(principalId, 'task.write');
      const next = proposeGoal(goal, this.scopedTasks(), principalId, source, request,
        grant.revision ?? 1, evidenceFingerprint);
      const result = this.status(next);
      (next.proposals ??= {})[key] = { fingerprint, result };
      this.save(next);
      return result;
    });
  }

  reconcileCandidate(records: readonly RuntimeSessionRecord[], pendingWait = false,
    waitFailure?: string, evidenceFingerprint?: string): void {
    this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal || !['finalizing', 'accepted'].includes(goal.disposition)) return;
      const tasks = this.scopedTasks();
      const inputs = records.flatMap(record => record.inputs.filter(input => this.association(input.intent)?.goalId === goal.goalId));
      const expected = this.inputBindings();
      const missing = [...expected.keys()].some(id => !inputs.some(input => input.intent.inputId === id));
      if (goal.proposal) {
        const grant = this.options.authorize(goal.proposal.principalId, 'task.write');
        if (goal.disposition === 'finalizing' && (grant.revision ?? 1) !== goal.proposal.authorityRevision)
          waitFailure = 'proposal-authority-changed';
      }
      const next = reconcileGoalCandidate(goal, tasks, inputs, pendingWait || missing, waitFailure, evidenceFingerprint);
      if (digest(next) !== digest(goal)) this.save(next);
      if (next.disposition !== 'accepted' || next.published || !next.proposal) return;
      const proposal = next.proposal;
      this.options.execute(proposal.principalId, { commandId: proposal.resultMessageId, operation: 'message.send',
        payload: { to: 'user', text: proposal.result, messageId: proposal.resultMessageId } },
        { result: { goalId: next.goalId, revision: next.revision } });
      next.published = true;
      this.save(next);
    });
  }

  taskFingerprint(): string { return goalTaskFingerprint(this.scopedTasks()); }

  private continuationCurrent(receipt: CommandReceipt, goal: GoalRecord): boolean {
    if (!receipt.goal?.continuation) return true;
    const board = this.options.policy.taskBoard();
    return goalContinuationCurrent({ receipt, goal, state: this.options.state(), scoped: this.scopedTasks(),
      allTasks: board.listTasks(), kanban: board.getKanbanState({ strict: true }), reports: this.workSyncReports(),
      history: this.continuations(), nowMs: Date.now() });
  }
}
