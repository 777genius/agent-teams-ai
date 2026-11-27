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

/** A bounded objective on the existing Team owner. No delivery queue or Runtime ownership. */
export class TeamGoals {
  constructor(private readonly options: {
    store: TeamStore;
    policy: TeamPolicyPort;
    state(): OwnerState;
    authorize(principalId: string, permission: TeamGrant['permissions'][number]): TeamGrant;
    authorizeDelivery(raw: ImmutableDelivery, action: 'read' | 'admit' | 'dispatch' | 'control'): boolean;
    execute: ExecuteGoalCommand;
    invalidate(): void;
  }) {}

  private state(): OwnerState {
    this.options.state();
    const state = this.options.store.read<OwnerState>('state.json');
    if (!state?.ready) throw new TeamOwnerError('hold');
    if (state.autonomousGoal) validateGoalRecord(state.autonomousGoal);
    return state;
  }

  private save(goal: GoalRecord): void {
    validateGoalRecord(goal);
    this.options.store.write('state.json', { ...this.state(), autonomousGoal: goal });
    this.options.invalidate();
  }

  snapshot(): GoalRecord | undefined {
    return this.options.store.fenced(() => structuredClone(this.state().autonomousGoal));
  }

  publicStatus(principalId: string): GoalStatus | undefined {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const goal = this.state().autonomousGoal;
      return goal && this.status(goal);
    });
  }

  private status(goal: GoalRecord): GoalStatus {
    const expired = Date.now() >= Date.parse(goal.deadlineAt);
    const used = Object.keys(goal.debits).length;
    const reason = goal.reason ?? (goal.disposition === 'active'
      ? expired ? 'deadline-reached' : used >= goal.attemptLimit ? 'attempt-limit-reached' : undefined
      : undefined);
    return {
      goalId: goal.goalId, revision: goal.revision, disposition: goal.disposition,
      startedAt: goal.startedAt, deadlineAt: goal.deadlineAt,
      attemptLimit: goal.attemptLimit, attemptsUsed: used,
      ...(reason ? { reason } : {}),
      ...(goal.disposition === 'accepted' && goal.proposal
        ? { resultMessageId: goal.proposal.resultMessageId, published: goal.published === true } : {}),
      ...(goal.disposition === 'stopped' && !expired && used < goal.attemptLimit ? { canResume: true } : {}),
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
          command.payload.actionMode === 'ask' || command.payload.nativeCommand ||
          !delivery || !preparation?.intake ||
          digest(memberBinding(preparation.intake.binding)) !== digest(memberBinding(delivery)) ||
          this.options.state().members.find(row => row.name === command.payload.to)?.role !== 'lead')
        throw new TeamOwnerError('forbidden');
      const old = this.state().autonomousGoal;
      const goalId = effectId('goal', this.options.state().binding.teamId, command.commandId);
      if (old && old.goalId !== goalId && !(old.disposition === 'accepted' && old.published))
        throw new TeamOwnerError('conflict');
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
      const tasks = new Map([...board.listTasks(), ...board.listDeletedTasks()].map(task => [task.id, task]));
      return [...this.taskIds(goal)].sort().map(id => structuredClone(tasks.get(id) ?? { id, status: 'missing' }));
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
      const intent = this.options.store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`)!;
      const receipt = readProductCommand(this.options.store, intent.commandId)!;
      const goal = this.state().autonomousGoal;
      if (!goal || goal.goalId !== association.goalId || goal.revision !== association.revision) return false;
      // The original authenticated user submission isn't an automatic attempt.
      if (receipt.goal?.kind === 'intake') return goal.disposition === 'active';
      if (goal.disposition !== 'active' || Date.now() >= Date.parse(goal.deadlineAt)) return false;
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
      if (goal?.disposition === 'finalizing' && !this.association(raw)) {
        goal.disposition = 'active'; delete goal.proposal; goal.reason = 'verification-changed';
        this.save(goal);
      }
      commitClaim();
    });
  }

  continue(next: GoalContinuation): CommandReceipt {
    return this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal || goal.disposition !== 'active' || Date.now() >= Date.parse(goal.deadlineAt))
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
    this.options.store.fenced(() => {
      const goal = this.state().autonomousGoal;
      if (!goal || goal.reason === reason || goal.disposition === 'accepted' || goal.disposition === 'stopped') return;
      if (reason === undefined) delete goal.reason;
      else goal.reason = reason.slice(0, 512);
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
      if (Object.keys(goal.controls ?? {}).length >= 256) throw new TeamOwnerError('hold');
      if (control.action === 'stop') {
        if (goal.disposition !== 'accepted') { goal.disposition = 'stopped'; goal.reason = 'stopped-by-user'; }
      } else if (control.action === 'resume') {
        if (!ready || goal.disposition !== 'stopped' || Date.now() >= Date.parse(goal.deadlineAt) ||
            Object.keys(goal.debits).length >= goal.attemptLimit) throw new TeamOwnerError('hold');
        goal.disposition = 'active'; delete goal.reason; delete goal.proposal;
      } else {
        if (goal.disposition === 'accepted' || (control.deadlineAt === undefined && control.attemptLimit === undefined))
          throw new TeamOwnerError('invalid');
        if (control.deadlineAt !== undefined) {
          if (Date.parse(control.deadlineAt) < Date.parse(goal.deadlineAt) ||
              Date.parse(control.deadlineAt) > Date.now() + 24 * 3600000) throw new TeamOwnerError('invalid');
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

  stopForRuntime(principalId: string, binding: RuntimeMemberBinding): void {
    this.options.store.fenced(() => {
      this.options.authorize(principalId, 'admin');
      const goal = this.state().autonomousGoal;
      if (!goal || !['active', 'finalizing'].includes(goal.disposition)) return;
      if (!this.options.state().members.some(row => row.delivery && digest(memberBinding(row.delivery)) === digest(memberBinding(binding))))
        throw new TeamOwnerError('forbidden');
      goal.disposition = 'stopped'; goal.reason = 'runtime-stopped'; this.save(goal);
    });
  }

  async retireObsolete(runtime: TeamRuntimeDeliveryPort): Promise<void> {
    if (!runtime.cancelDelivery) return;
    const obsolete = this.options.store.fenced(() => this.options.store.list<DeliveryIntent>('outbox')
      .filter(intent => {
        const association = this.association(intent), goal = this.state().autonomousGoal;
        if (!association) return false;
        return !goal || association.goalId !== goal.goalId || association.revision !== goal.revision ||
          goal.disposition !== 'active' || Date.now() >= Date.parse(goal.deadlineAt) ||
          (!goal.debits[intent.inputId] && Object.keys(goal.debits).length >= goal.attemptLimit);
      })
      .filter(intent => readProductCommand(this.options.store, intent.commandId)?.goal?.kind !== 'intake'));
    for (const intent of obsolete) {
      // Runtime owns claimed/unknown outcomes; cancellation never replays or erases them.
      try { await runtime.cancelDelivery(intent); } catch { /* Retain original debt. */ }
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
      const root = readProductCommand(this.options.store, goal.rootCommandId);
      const expected = [root?.effects.deliveryId, ...Object.keys(goal.debits)];
      const missing = expected.some(id => !id || !inputs.some(input => input.intent.inputId === id));
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
}
