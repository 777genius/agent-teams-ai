import { digest, effectId, safeSegment, stableJson } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import { DeliveryRecovery, deliveryIdentity, memberBinding } from './DeliveryRecovery.js';
import { TaskRecovery } from './TaskRecovery.js';
import { TaskPolicyRejected } from './ports.js';

import type {
  TaskBoardPolicy,
  TaskMutationPort,
  TeamPolicyPort,
  TeamStore,
  TeamTask,
} from './ports.js';
import type { JsonValue } from '../contracts.js';
import type {
  CommandReceipt,
  DeliveryIntent,
  DeliveryResumeResult,
  ImmutableDelivery,
  RuntimeMemberBinding,
  TaskRef,
  TeamBinding,
  TeamCommand,
  TeamGrant,
  TeamMember,
  TeamRuntimeDeliveryPort,
} from './contracts.js';

export interface TeamOwnerOptions {
  binding: TeamBinding;
  /** Bootstrap-only trusted composition values; reopening never resets grants/config. */
  members: TeamMember[];
  grants: TeamGrant[];
  store: TeamStore;
  policy: TeamPolicyPort;
  taskMutations: TaskMutationPort;
}

interface OwnerState {
  schemaVersion: 1;
  binding: TeamBinding;
  members: TeamMember[];
  grants: TeamGrant[];
  ready: boolean;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function text(value: unknown, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 1_000_000)
    throw new TeamOwnerError('invalid');
}

function validateRefs(value: TaskRef[] | undefined): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 1000) throw new TeamOwnerError('invalid');
  for (const ref of value) {
    if (!ref || typeof ref !== 'object') throw new TeamOwnerError('invalid');
    safeSegment(ref.taskId);
    safeSegment(ref.teamName);
    text(ref.displayId);
    if (
      ref.displayId.length > 128 ||
      ref.displayId.trim() !== ref.displayId ||
      Object.keys(ref).some((key) => !['taskId', 'teamName', 'displayId'].includes(key))
    )
      throw new TeamOwnerError('invalid');
  }
}

function validateCommand(command: TeamCommand): void {
  if (!command || typeof command !== 'object') throw new TeamOwnerError('invalid');
  text(command.commandId);
  if (command.commandId.length > 256) throw new TeamOwnerError('invalid');
  const payload = command.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new TeamOwnerError('invalid');
  switch (command.operation) {
    case 'task.create':
      validateRefs(command.payload.descriptionTaskRefs);
      text(command.payload.subject);
      if (command.payload.description !== undefined) text(command.payload.description, true);
      if (command.payload.owner !== undefined) text(command.payload.owner);
      if (command.payload.blockedBy !== undefined) {
        if (!Array.isArray(command.payload.blockedBy)) throw new TeamOwnerError('invalid');
        command.payload.blockedBy.forEach((id) => safeSegment(id));
      }
      break;
    case 'task.update':
      safeSegment(command.payload.taskId);
      if (command.payload.subject === undefined && command.payload.description === undefined)
        throw new TeamOwnerError('invalid');
      if (command.payload.subject !== undefined) text(command.payload.subject);
      if (command.payload.description !== undefined) text(command.payload.description, true);
      break;
    case 'task.assign':
      safeSegment(command.payload.taskId);
      text(command.payload.owner);
      break;
    case 'task.lifecycle':
      safeSegment(command.payload.taskId);
      if (!['start', 'complete', 'delete', 'restore', 'pending'].includes(command.payload.action))
        throw new TeamOwnerError('invalid');
      break;
    case 'task.comment':
      validateRefs(command.payload.taskRefs);
      safeSegment(command.payload.taskId);
      text(command.payload.text);
      break;
    case 'message.send':
      validateRefs(command.payload.taskRefs);
      safeSegment(command.payload.to);
      text(command.payload.text);
      break;
    default:
      throw new TeamOwnerError('invalid');
  }
  const allowed: Record<TeamCommand['operation'], string[]> = {
    'task.create': ['subject', 'description', 'owner', 'blockedBy', 'descriptionTaskRefs'],
    'task.update': ['taskId', 'subject', 'description'],
    'task.assign': ['taskId', 'owner'],
    'task.lifecycle': ['taskId', 'action'],
    'task.comment': ['taskId', 'text', 'taskRefs'],
    'message.send': ['to', 'text', 'taskRefs'],
  };
  if (
    Object.keys(command).some((key) => !['commandId', 'operation', 'payload'].includes(key)) ||
    Object.keys(payload).some((key) => !allowed[command.operation].includes(key))
  )
    throw new TeamOwnerError('invalid');
  // Reject non-JSON values, unsupported objects and conflicting identity overrides.
  stableJson(command);
  for (const key of ['from', 'actor', 'createdBy', 'id', 'messageId', 'creationCommand'])
    if (Object.hasOwn(payload, key)) throw new TeamOwnerError('invalid');
}

/**
 * One Team's product owner. All local transitions are synchronous within the same
 * filesystem authority fence. Native delivery is deliberately not dispatched here.
 */
export class TeamOwner {
  private readonly store: TeamStore;
  private readonly policy: TeamPolicyPort;
  private readonly binding: TeamBinding;
  private readonly deliveryRecovery: DeliveryRecovery;
  private readonly taskRecovery: TaskRecovery;

  constructor(options: TeamOwnerOptions) {
    this.binding = structuredClone(options.binding);
    for (const value of Object.values(this.binding)) safeSegment(value);
    this.store = options.store;
    this.policy = options.policy;
    this.store.fenced(() => {
      const current = this.store.read<OwnerState>('state.json');
      if (current) {
        if (digest(current.binding) !== digest(this.binding)) throw new TeamOwnerError('conflict');
        if (!current.ready) this.finishBootstrap(current);
        return;
      }
      for (const member of options.members) {
        safeSegment(member.name);
        safeSegment(member.memberId);
        if (
          member.delivery &&
          (digest({
            backendId: member.delivery.backendId,
            teamId: member.delivery.teamId,
            teamName: member.delivery.teamName,
          }) !== digest(this.binding) ||
            member.delivery.memberId !== member.memberId)
        )
          throw new TeamOwnerError('invalid');
      }
      if (
        new Set(options.members.map((member) => member.name.toLowerCase())).size !==
        options.members.length
      )
        throw new TeamOwnerError('invalid');
      for (const grant of options.grants) {
        text(grant.principalId);
        if (
          grant.memberName !== 'user' &&
          !options.members.some((member) => member.name === grant.memberName)
        )
          throw new TeamOwnerError('invalid');
      }
      if (this.store.read('../config.json') !== undefined) throw new TeamOwnerError('conflict');
      const state: OwnerState = {
        schemaVersion: 1,
        binding: this.binding,
        members: options.members,
        grants: options.grants.map((grant) => ({ ...grant, revision: grant.revision ?? 1 })),
        ready: false,
      };
      this.store.write('state.json', state);
      this.finishBootstrap(state);
    });
    this.taskRecovery = new TaskRecovery(
      this.store,
      options.taskMutations,
      (receipt) => this.taskAuthorityCurrent(receipt),
      (receipt) => {
        this.execute(receipt.principalId, receipt.command);
      }
    );
    this.deliveryRecovery = new DeliveryRecovery(
      this.store,
      (intent) => !this.taskRecovery.retracting(intent) && this.deliveryAuthorized(intent)
    );
  }

  /** Trusted host composition only; this capability is intentionally absent from connect/MCP. */
  resumeDeliveries(runtime: TeamRuntimeDeliveryPort): Promise<DeliveryResumeResult[]> {
    return this.deliveryRecovery.resume(runtime);
  }

  /** Trusted startup continuation; it reuses prepared Task facts, never canonical handlers. */
  resumeTaskCommands(runtime?: TeamRuntimeDeliveryPort) {
    return this.taskRecovery.resume(runtime);
  }

  authorizeRuntimeAccess(
    principalId: string,
    binding: RuntimeMemberBinding,
    action: 'read' | 'control'
  ): boolean {
    return this.store.fenced(() => {
      try {
        const grant = this.authorize(principalId, 'read');
        const member = this.state().members.find(
          (candidate) =>
            candidate.delivery &&
            digest(memberBinding(candidate.delivery)) === digest(memberBinding(binding))
        );
        if (!member) return false;
        return (
          action === 'read' ||
          grant.permissions.includes('admin') ||
          (member?.name === grant.memberName &&
            (grant.permissions.includes('task.write') ||
              grant.permissions.includes('message.write')))
        );
      } catch {
        return false;
      }
    });
  }

  /** Synchronous Runtime-fence callback; callers separately authenticate user/admin control. */
  authorizeMemberBinding(
    binding: RuntimeMemberBinding,
    action: 'read' | 'admit' | 'dispatch' | 'control'
  ): boolean {
    return this.store.fenced(() => this.memberAuthorized(binding, action));
  }

  /** Runtime passes the original persisted input identity, never an actor claimed by a tool. */
  authorizeDeliveryIntent(
    raw: ImmutableDelivery,
    action: 'read' | 'admit' | 'dispatch' | 'control' = 'admit'
  ): boolean {
    return this.store.fenced(() => {
      try {
        if (
          (action === 'control' || action === 'read') &&
          this.taskRecovery.authorizeRetraction(raw)
        )
          return true;
        if ((action === 'admit' || action === 'dispatch') && this.taskRecovery.retracting(raw))
          return false;
        safeSegment(raw.deliveryId);
        const intent = this.store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`);
        return (
          !!intent &&
          digest(deliveryIdentity(raw)) === digest(deliveryIdentity(intent)) &&
          this.deliveryAuthorized(intent)
        );
      } catch {
        return false;
      }
    });
  }

  private memberAuthorized(
    binding: RuntimeMemberBinding,
    action: 'read' | 'admit' | 'dispatch' | 'control'
  ): boolean {
    try {
      const state = this.state();
      const member = state.members.find(
        (candidate) =>
          candidate.delivery &&
          digest(memberBinding(candidate.delivery)) === digest(memberBinding(binding))
      );
      if (!member) return false;
      return state.grants.some(
        (grant) =>
          grant.memberName === member.name &&
          !grant.revoked &&
          grant.permissions.includes('read') &&
          (action === 'read' ||
            action === 'control' ||
            grant.permissions.includes('message.write') ||
            grant.permissions.includes('task.write'))
      );
    } catch {
      return false;
    }
  }

  /** Called under the same Team fence as mutations/revoke and outbox publication. */
  private deliveryAuthorized(intent: DeliveryIntent): boolean {
    try {
      if (intent.schemaVersion !== 1 || !this.memberAuthorized(intent.binding, 'admit'))
        return false;
      const receipt = this.store.read<CommandReceipt>(this.commandPath(intent.commandId));
      if (receipt && receipt.command.operation !== 'message.send')
        return this.taskAuthorityCurrent(receipt) && this.taskRecovery.owns(intent, receipt);
      const grant = this.authorize(intent.principalId, 'message.write');
      if ((grant.revision ?? 1) !== intent.authorityRevision) return false;
      if (
        !receipt ||
        receipt.command.operation !== 'message.send' ||
        receipt.phase === 'rejected' ||
        receipt.principalId !== intent.principalId ||
        receipt.effects.messageId !== intent.messageId ||
        receipt.effects.deliveryId !== intent.deliveryId ||
        intent.inputId !== intent.deliveryId ||
        receipt.command.payload.text !== intent.content ||
        !receipt.deliveryBinding ||
        digest(receipt.deliveryBinding) !== digest(intent.binding) ||
        receipt.authorityRevision !== intent.authorityRevision ||
        receipt.fingerprint !==
          digest({
            binding: this.binding,
            principalId: receipt.principalId,
            command: receipt.command,
            deliveryBinding: receipt.deliveryBinding,
          })
      )
        return false;
      const member = this.state().members.find(
        (candidate) => candidate.memberId === intent.binding.memberId
      );
      return !!member && member.name === receipt.command.payload.to;
    } catch {
      return false;
    }
  }

  private finishBootstrap(state: OwnerState): void {
    const expected = {
      name: this.binding.teamName,
      members: state.members.map((member) => ({
        name: member.name,
        agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
      })),
    };
    const config = this.store.read<unknown>('../config.json');
    if (config !== undefined && digest(config) !== digest(expected))
      throw new TeamOwnerError('hold');
    if (config === undefined) this.store.write('../config.json', expected);
    this.store.write('state.json', { ...state, ready: true });
  }

  /** principalId must come from captured IPC/MCP authentication, not tool arguments. */
  connect(principalId: string) {
    text(principalId);
    return Object.freeze({
      execute: (command: TeamCommand) => this.execute(principalId, command),
      lookup: (commandId: string) => this.lookup(principalId, commandId),
      getTask: (taskId: string) => this.getTask(principalId, taskId),
      listTasks: () => this.listTasks(principalId),
      pendingDeliveries: () => this.pendingDeliveries(principalId),
      revoke: (target: string) => this.revoke(principalId, target),
    });
  }

  private state(): OwnerState {
    const state = this.store.read<OwnerState>('state.json');
    if (
      !state ||
      !state.ready ||
      state.schemaVersion !== 1 ||
      digest(state.binding) !== digest(this.binding)
    )
      throw new TeamOwnerError('hold');
    return state;
  }

  private authorize(principalId: string, permission: TeamGrant['permissions'][number]): TeamGrant {
    const grant = this.state().grants.find((entry) => entry.principalId === principalId);
    if (!grant || grant.revoked || !grant.permissions.includes(permission))
      throw new TeamOwnerError('forbidden');
    return grant;
  }

  private commandPath(commandId: string): string {
    text(commandId);
    return `commands/${digest(commandId)}.json`;
  }

  private taskAuthorityCurrent(receipt: CommandReceipt): boolean {
    try {
      const grant = this.authorize(receipt.principalId, 'task.write');
      this.authorize(receipt.principalId, 'read');
      const current = this.store.read<CommandReceipt>(this.commandPath(receipt.commandId));
      return (
        receipt.command.operation !== 'message.send' &&
        receipt.phase !== 'rejected' &&
        receipt.authorityRevision === (grant.revision ?? 1) &&
        !!current &&
        current.fingerprint === receipt.fingerprint &&
        current.authorityRevision === receipt.authorityRevision &&
        receipt.fingerprint ===
          digest({
            binding: this.binding,
            principalId: receipt.principalId,
            command: receipt.command,
            taskRecipients: receipt.taskRecipients,
          })
      );
    } catch {
      return false;
    }
  }

  private lookup(principalId: string, commandId: string): CommandReceipt | undefined {
    return this.store.fenced(() => {
      this.authorize(principalId, 'read');
      const receipt = this.store.read<CommandReceipt>(this.commandPath(commandId));
      if (receipt && receipt.principalId !== principalId) throw new TeamOwnerError('forbidden');
      return receipt;
    });
  }

  private revoke(principalId: string, target: string): void {
    this.store.fenced(() => {
      this.authorize(principalId, 'admin');
      const state = this.state();
      const targetGrant = state.grants.find((grant) => grant.principalId === target);
      if (!targetGrant) throw new TeamOwnerError('invalid');
      if (targetGrant.revoked) return;
      targetGrant.revoked = true;
      targetGrant.revision = (targetGrant.revision ?? 1) + 1;
      this.store.write('state.json', state);
    });
  }

  private getTask(principalId: string, taskId: string): TeamTask {
    return this.store.fenced(() => {
      this.authorize(principalId, 'read');
      safeSegment(taskId);
      return this.policy.taskBoard().getTask(taskId);
    });
  }

  private listTasks(principalId: string): TeamTask[] {
    return this.store.fenced(() => {
      this.authorize(principalId, 'read');
      return this.policy.taskBoard().listTasks();
    });
  }

  private pendingDeliveries(principalId: string): DeliveryIntent[] {
    return this.store.fenced(() => {
      this.authorize(principalId, 'read');
      return this.store
        .list<DeliveryIntent>('outbox')
        .filter((entry) => entry.phase === 'pending' && entry.principalId === principalId);
    });
  }

  private execute(principalId: string, rawCommand: TeamCommand): CommandReceipt {
    validateCommand(rawCommand);
    const command = structuredClone(rawCommand);
    return this.store.fenced(() => {
      const grant = this.authorize(
        principalId,
        command.operation === 'message.send' ? 'message.write' : 'task.write'
      );
      // Completed replay must pass current authority, not only the original mutation's check.
      this.authorize(principalId, 'read');
      const location = this.commandPath(command.commandId);
      let receipt = this.store.read<CommandReceipt>(location);
      const deliveryBinding =
        receipt?.deliveryBinding ??
        (command.operation === 'message.send'
          ? this.state().members.find((member) => member.name === command.payload.to)?.delivery
          : undefined);
      const taskRecipients = receipt
        ? receipt.taskRecipients
        : command.operation !== 'message.send'
          ? this.state().members.map(({ name, delivery }) => ({
              name,
              ...(delivery ? { delivery: structuredClone(delivery) } : {}),
            }))
          : undefined;
      if (taskRecipients && taskRecipients.length > 256) throw new TeamOwnerError('hold');
      const fingerprint = digest({
        binding: this.binding,
        principalId,
        command,
        deliveryBinding,
        taskRecipients,
      });
      if (receipt) {
        if (receipt.principalId !== principalId || receipt.fingerprint !== fingerprint)
          throw new TeamOwnerError('conflict');
        if (receipt.phase === 'completed' || receipt.phase === 'rejected') return receipt;
        if (
          command.operation !== 'message.send' &&
          receipt.phase !== 'prepared' &&
          !this.taskRecovery.hasPlan(receipt) &&
          (receipt.taskPlanVersion !== 1 ||
            receipt.taskPreimage !== this.store.productFingerprint(this.binding.teamName))
        )
          throw new TeamOwnerError('hold');
      } else {
        if (command.operation === 'message.send') {
          const to = command.payload.to;
          if (
            to === 'user'
              ? grant.memberName === 'user'
              : !this.state().members.some((member) => member.name === to && member.delivery)
          )
            throw new TeamOwnerError('invalid');
        }
        const pending = this.store.list<CommandReceipt>('commands');
        if (
          command.operation !== 'message.send' &&
          pending.some(
            (entry) =>
              entry.command.operation !== 'message.send' &&
              !['completed', 'rejected'].includes(entry.phase)
          )
        )
          throw new TeamOwnerError('hold');
        const seed = [this.binding.backendId, this.binding.teamId, command.commandId];
        receipt = {
          schemaVersion: 1,
          binding: this.binding,
          commandId: command.commandId,
          principalId,
          fingerprint,
          command,
          effects: {
            taskId: effectId('task', ...seed),
            commentId: effectId('comment', ...seed),
            messageId: effectId('message', ...seed),
            deliveryId: effectId('delivery', ...seed),
          },
          createdAt: new Date().toISOString(),
          phase: 'prepared',
          authorityRevision: grant.revision ?? 1,
          ...(command.operation !== 'message.send'
            ? {
                taskPlanVersion: 1 as const,
                taskPreimage: this.store.productFingerprint(this.binding.teamName),
                taskRecipients: taskRecipients!,
              }
            : {}),
          ...(deliveryBinding
            ? {
                deliveryBinding: structuredClone(deliveryBinding),
                authorityRevision: grant.revision ?? 1,
              }
            : {}),
        };
        this.store.write(location, receipt);
      }
      receipt.phase = 'applying';
      this.store.write(location, receipt);
      const before = this.store.productFingerprint(this.binding.teamName);
      try {
        if (command.operation === 'message.send')
          receipt.result = this.commitMessage(receipt, grant.memberName);
        else {
          const plan = this.taskRecovery.commit(
            receipt,
            grant.memberName,
            this.state().members,
            (board) => this.applyTask(receipt, grant.memberName, board)
          );
          receipt.result = plan.result;
          receipt.taskHash = plan.taskHash;
        }
        receipt.phase = 'completed';
        this.store.write(location, receipt);
        return receipt;
      } catch (error) {
        if (
          command.operation !== 'message.send' &&
          error instanceof TaskPolicyRejected &&
          this.store.productFingerprint(this.binding.teamName) === before &&
          !receipt.result
        ) {
          receipt.phase = 'rejected';
          receipt.result = { rejected: true, reason: 'policy' };
          this.store.write(location, receipt);
          return receipt;
        }
        // Exception may follow partial filesystem effects; never label it not-applied.
        receipt.phase = 'held';
        this.store.write(location, receipt);
        throw new TeamOwnerError('hold');
      }
    });
  }

  private applyTask(receipt: CommandReceipt, actor: string, board: TaskBoardPolicy): JsonValue {
    const command = receipt.command;
    switch (command.operation) {
      case 'task.create':
        return json(
          board.createTask({
            ...command.payload,
            id: receipt.effects.taskId,
            from: actor,
            createdAt: receipt.createdAt,
            allowLegacyAdoption: false,
            creationCommand: {
              namespace: 'legacy-agent-host',
              scopeKey: this.binding.teamName,
              operation: command.operation,
              commandId: receipt.effects.taskId,
              payloadHash: receipt.fingerprint,
            },
          })
        );
      case 'task.update': {
        const { taskId, ...fields } = command.payload;
        return json(board.updateTaskFields(taskId, fields));
      }
      case 'task.assign':
        return json(board.setTaskOwner(command.payload.taskId, command.payload.owner, actor));
      case 'task.comment':
        return json(
          board.addTaskComment(command.payload.taskId, {
            text: command.payload.text,
            taskRefs: command.payload.taskRefs,
            from: actor,
            id: receipt.effects.commentId,
            createdAt: receipt.createdAt,
          })
        );
      case 'task.lifecycle': {
        const { taskId, action } = command.payload;
        if (action === 'start') return json(board.startTask(taskId, actor));
        if (action === 'complete') return json(board.completeTask(taskId, actor));
        if (action === 'delete') return json(board.softDeleteTask(taskId, actor));
        if (action === 'restore') return json(board.restoreTask(taskId, actor));
        return json(board.setTaskStatus(taskId, 'pending', actor));
      }
      default:
        throw new TeamOwnerError('invalid');
    }
  }

  private commitMessage(receipt: CommandReceipt, actor: string): JsonValue {
    if (receipt.command.operation !== 'message.send') throw new TeamOwnerError('invalid');
    const { to, text: content, taskRefs } = receipt.command.payload;
    const member = this.state().members.find((candidate) => candidate.name === to);
    if (to === 'user' ? actor === 'user' : !member?.delivery) throw new TeamOwnerError('invalid');
    if (
      to !== 'user' &&
      (!receipt.deliveryBinding ||
        receipt.authorityRevision === undefined ||
        digest(member!.delivery) !== digest(receipt.deliveryBinding))
    )
      throw new TeamOwnerError('hold');
    const row = {
      from: actor,
      to,
      text: content,
      timestamp: receipt.createdAt,
      messageId: receipt.effects.messageId,
      read: false,
      ...(taskRefs?.length ? { taskRefs } : {}),
    };
    // The canonical writer can deduplicate semantically, not just by supplied ID.
    // Only exact identity/bytes can satisfy this command's effect proof.
    const inbox = this.policy.readInbox(to);
    const existing = inbox.find(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        entry.messageId === row.messageId
    );
    if (existing) {
      if (digest({ ...(existing as Record<string, JsonValue>), read: false }) !== digest(row))
        throw new TeamOwnerError('hold');
    } else {
      const applied = this.policy.sendMessage(actor, { ...row, member: to });
      if (applied.messageId !== row.messageId || digest(applied.message) !== digest(row))
        throw new TeamOwnerError('hold');
    }
    if (to === 'user') return json({ messageId: row.messageId, message: row });
    if (
      !member?.delivery ||
      !receipt.deliveryBinding ||
      receipt.authorityRevision === undefined ||
      digest(member.delivery) !== digest(receipt.deliveryBinding)
    )
      throw new TeamOwnerError('hold');
    const location = `outbox/${receipt.effects.deliveryId}.json`;
    const intent: DeliveryIntent = {
      schemaVersion: 1,
      binding: receipt.deliveryBinding,
      commandId: receipt.commandId,
      principalId: receipt.principalId,
      messageId: row.messageId,
      deliveryId: receipt.effects.deliveryId,
      inputId: receipt.effects.deliveryId,
      content,
      authorityRevision: receipt.authorityRevision,
      phase: 'pending',
    };
    const previous = this.store.read<DeliveryIntent>(location);
    if (previous) {
      if (digest({ ...previous, phase: 'pending', runtimeReceipt: undefined }) !== digest(intent))
        throw new TeamOwnerError('hold');
    } else this.store.write(location, intent);
    return json({ messageId: row.messageId, deliveryId: intent.deliveryId, message: row });
  }
}
