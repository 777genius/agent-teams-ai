import { executeTeamCommand } from './executeTeamCommand.js';
import { captureCommandSelection } from './captureCommandSelection.js';
import { teamCommandFingerprint } from './teamCommandFingerprint.js';
import { validateCommandAttachments } from './validateCommandAttachments.js';
import { readGroupInputSource } from '../group-chats/readGroupInputSource.js';
import type { NativeMcpAuthorityProof } from './NativeMcpAuthority.js';
import { groupTargetCommand, canonicalGroupMessages } from '../group-chats/groupDelivery.js';
import type {
  GroupStorageFactory,
  GroupRuntimeAccess,
} from '../group-chats/createGroupCommandAccess.js';
import type { CapturedGroupIntent } from '../group-chats/groupCommandRecords.js';
import { withNativeMemberActionAuthority } from './NativeMemberActionAuthority.js';
import type { NativeMemberActionRequest } from './NativeMemberActionAuthority.js';
import { captureNativeMcpAuthority } from './NativeMcpAuthority.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import { initializeTeamOwner } from './initializeTeamOwner.js';
import { assertTeamExecutionAllowed } from './teamLifecycleAdmission.js';
import { createTeamReadQueries } from './createTeamReadQueries.js';
import { TeamContextReminders } from './TeamContextReminders.js';
import { projectCrossTeamMessages } from '../cross-team/projectCrossTeamMessages.js';
import { ordinarySubagentAllowed } from './ordinarySubagentPolicy.js';
import { lookupRetainedTaskStartCause } from './lookupRetainedTaskStartCause.js';
import { readCrossTeamReplyHints } from './readCrossTeamReplyHints.js';
import { createTeamDeliveryAuthority } from './TeamDeliveryAuthority.js';
import { crossTeamTargetCommand } from '../cross-team/crossTeamInbound.js';
import type { CapturedCrossTeamIntent } from '../cross-team/contracts.js';
import { lookupEvidenceCause } from './lookupEvidenceCause.js';
import { json } from './TeamReviewCommands.js';
import { createTeamCommandAccess } from './createTeamCommandAccess.js';
import type { TeamProcessRuntimeAccess } from './createTeamCommandAccess.js';
import { readProductCommand, lookupOwnedProductCommand } from './commandEntries.js';
import { isUserTaskStartIntent, requiresHumanTaskActor } from './taskStartIntent.js';
import { digest, safeSegment } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import { DeliveryRecovery, memberBinding } from './DeliveryRecovery.js';
import { TaskRecovery } from './TaskRecovery.js';
import { TeamProductChanges } from './TeamProductChanges.js';
import { TeamRuntimeRegistration } from './TeamRuntimeRegistration.js';
import type { RegisterTeamRuntime } from './runtimeRegistrationContracts.js';
import { TeamRosterTransitions } from './TeamRosterTransitions.js';
import { teamRosterRevision } from './rosterSchema.js';
import { validateTeamCommand, validateTeamText } from './validateTeamCommand.js';

import type {
  TaskMutationPort,
  TeamPolicyPort,
  TeamStore,
  TeamTask,
  TeamRuntimeBindings,
} from './ports.js';
import type { JsonValue } from '../contracts.js';
import type { OwnerState } from './ownerState.js';
import type { ReplaceTeamRoster, TeamSavedSettings } from './rosterContracts.js';
import type {
  CommandReceipt,
  DeliveryIntent,
  DeliveryResumeResult,
  ImmutableDelivery,
  RuntimeMemberBinding,
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
  /** Trusted creation-only inactive metadata; never grants delivery or runtime authority. */
  removedMembers?: OwnerState['removedMembers'];
  savedSettings?: TeamSavedSettings;
  grants: TeamGrant[];
  store: TeamStore;
  policy: TeamPolicyPort;
  taskMutations: TaskMutationPort;
  runtimeBindings?: TeamRuntimeBindings;
  /** Synchronous Runtime proof; absent composition permits only product-only members. */
  assertRosterEditable?(members: readonly TeamMember[]): void;
  groupStorage?: GroupStorageFactory;
  crossTeamSourceAuthority?(intent: CapturedCrossTeamIntent): boolean;
}

/**
 * One Team's product owner. All local transitions are synchronous within the same
 * filesystem authority fence. Native delivery is deliberately not dispatched here.
 */
export class TeamOwner {
  /** Trusted composition only; never exposed on connect/MCP. */
  readonly contextReminders: TeamContextReminders;
  readonly nativeRoster: Pick<TeamRosterTransitions, 'nativeCreation' | 'capturedMemberCurrent'>;
  private readonly commandAccess: ReturnType<typeof createTeamCommandAccess>;
  private readonly productChanges = new TeamProductChanges();
  private readonly store: TeamStore;
  private readonly policy: TeamPolicyPort;
  private readonly binding: TeamBinding;
  private readonly deliveryRecovery: DeliveryRecovery;
  private readonly deliveryAuthority: ReturnType<typeof createTeamDeliveryAuthority>;
  private readonly taskRecovery: TaskRecovery;
  private readonly runtimeBindings: TeamRuntimeBindings | undefined;
  private readonly roster: TeamRosterTransitions;
  private readonly runtimeRegistration: TeamRuntimeRegistration;

  constructor(options: TeamOwnerOptions) {
    this.binding = structuredClone(options.binding);
    for (const value of Object.values(this.binding)) safeSegment(value);
    this.store = options.store;
    this.runtimeBindings = options.runtimeBindings;
    this.policy = options.policy;
    this.contextReminders = new TeamContextReminders({
      store: this.store,
      policy: this.policy,
      state: () => this.state(),
      authorize: (principalId) => this.authorize(principalId, 'read'),
    });
    this.commandAccess = createTeamCommandAccess({
      store: this.store,
      binding: this.binding,
      policy: this.policy,
      state: () => this.state(),
      recoverConfig: (state) => this.roster.recover(state),
      ownsTaskIntent: (intent, receipt) => this.taskRecovery.owns(intent, receipt),
      runtimeBindings: this.runtimeBindings,
      groupStorage: options.groupStorage,
      receiveGroup: (principalId, intent) =>
        this.execute(principalId, groupTargetCommand(intent), undefined, intent),
      authorize: (principalId, permission) => this.authorize(principalId, permission),
      invalidate: () => this.productChanges.invalidate(),
    });
    initializeTeamOwner({ ...options, binding: this.binding, store: this.store }, (state) =>
      this.finishBootstrap(state)
    );
    const assertEditable = (members: readonly TeamMember[]): void => {
      if (options.assertRosterEditable) {
        const result: unknown = options.assertRosterEditable(members);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw new TeamOwnerError('hold');
        }
      } else if (members.some((member) => member.delivery)) throw new TeamOwnerError('hold');
    };
    this.roster = new TeamRosterTransitions({
      binding: this.binding,
      store: this.store,
      state: () => this.state(),
      authorize: (principalId, permission) => this.authorize(principalId, permission),
      assertEditable,
      invalidate: () => this.productChanges.invalidate(),
    });
    this.nativeRoster = this.roster;
    this.runtimeRegistration = new TeamRuntimeRegistration({
      binding: this.binding,
      store: this.store,
      state: () => this.state(),
      authorize: (principalId, permission) => this.authorize(principalId, permission),
      assertEditable,
      hasRuntimeProof: !!options.assertRosterEditable,
      invalidate: () => this.productChanges.invalidate(),
    });
    this.taskRecovery = new TaskRecovery(
      this.store,
      options.taskMutations,
      (receipt) => this.taskAuthorityCurrent(receipt),
      (receipt) => {
        this.execute(receipt.principalId, receipt.command);
      }
    );
    this.deliveryAuthority = createTeamDeliveryAuthority({
      binding: this.binding,
      store: this.store,
      state: () => this.state(),
      authorize: (principal, permission) => this.authorize(principal, permission),
      runtimeBindings: this.runtimeBindings,
      taskRecovery: this.taskRecovery,
      authorizeRetainedCancellation: this.commandAccess.authorizeRetainedCancellation,
      retractingRetainedDelivery: this.commandAccess.retractingRetainedDelivery,
      taskAuthorityCurrent: (receipt) => this.taskAuthorityCurrent(receipt),
      crossTeamSourceAuthority: options.crossTeamSourceAuthority,
    });
    this.deliveryRecovery = new DeliveryRecovery(
      this.store,
      (intent) =>
        !this.taskRecovery.retracting(intent) && this.deliveryAuthority.deliveryAuthorized(intent)
    );
    this.commandAccess.lifecycleContinuation.recover();
  }

  assertExecutionAllowed(principalId: string): void {
    this.store.fenced(() => {
      this.authorize(principalId, 'admin');
      assertTeamExecutionAllowed(this.state(), this.store);
    });
  }
  recoverQueuedMessages(runtime: TeamRuntimeDeliveryPort) {
    return this.commandAccess.recoverQueuedMessages(runtime);
  }
  queuedMessages(principalId: string, runtime: TeamRuntimeDeliveryPort) {
    return this.commandAccess.queuedMessages(principalId, runtime);
  }
  lifecycleCommands(principalId: string) {
    return this.commandAccess.lifecycle(principalId);
  }
  /** Trusted composition continuation, never exposed through connect/MCP. */
  lifecycleContinuation() {
    return this.commandAccess.lifecycleContinuation;
  }
  continueLifecycleCleanup(
    commandId: string,
    runtime: Pick<RuntimeOwner, 'stopCapturedSession' | 'readCapturedSession'>,
    delivery: TeamRuntimeDeliveryPort
  ) {
    return this.commandAccess.continueLifecycleCleanup(commandId, runtime, delivery);
  }
  reviewCommands(principalId: string) {
    return this.commandAccess.review(principalId);
  }
  /** Trusted native composition; no raw receipt or filesystem selector crosses this boundary. */
  groupInputSource(principalId: string, proof: Readonly<NativeMcpAuthorityProof>) {
    return this.store.fenced(() =>
      readGroupInputSource({
        store: this.store,
        proof,
        capture: (raw) => this.captureNativeMcpAuthority(principalId, proof.source, raw, false),
      })
    );
  }
  groupCommands(principalId: string, runtime: GroupRuntimeAccess) {
    return this.commandAccess.groups.commands(principalId, runtime);
  }
  crossTeamCommands(principalId: string) {
    return this.commandAccess.crossTeam(principalId);
  }
  /** Private feature composition; actual native original-input proof is required for every mutation. */
  workSyncCommands(principalId: string) {
    return this.commandAccess.workSync(principalId);
  }
  processCommands(principalId: string, runtime?: TeamProcessRuntimeAccess) {
    return this.commandAccess.process(principalId, runtime);
  }

  /** Trusted composition only; never exposed through connect/MCP. */
  registerRuntime(principalId: string, input: RegisterTeamRuntime) {
    return this.runtimeRegistration.register(principalId, input);
  }
  /** Trusted composition only; same registration/custody guards, with no publication. */
  assertRuntimeRegistration(principalId: string, input: RegisterTeamRuntime): string {
    return this.runtimeRegistration.assertRegistration(principalId, input);
  }
  runtimeCapture(principalId: string) {
    return this.runtimeRegistration.current(principalId);
  }
  runtimeCaptures(principalId: string) {
    return this.runtimeRegistration.all(principalId);
  }
  hasRuntimeCapture(principalId: string, binding: RuntimeMemberBinding): boolean {
    return this.runtimeRegistration.has(principalId, binding);
  }

  /** Trusted host composition only; this capability is intentionally absent from connect/MCP. */
  matchesCapturedRoster(
    members: readonly Pick<TeamMember, 'memberId' | 'name' | 'role' | 'settings'>[],
    savedSettings?: TeamSavedSettings
  ): boolean {
    return this.store.fenced(() => {
      const state = this.state();
      return (
        teamRosterRevision(state.members, state.rosterVersion, state.savedSettings) ===
        teamRosterRevision(members, 0, savedSettings)
      );
    });
  }

  /** Trusted host composition only; this capability is intentionally absent from connect/MCP. */
  resumeDeliveries(runtime: TeamRuntimeDeliveryPort): Promise<DeliveryResumeResult[]> {
    return this.deliveryRecovery.resume(runtime);
  }

  /** Trusted startup continuation; it reuses prepared Task facts, never canonical handlers. */
  resumeTaskCommands(runtime?: TeamRuntimeDeliveryPort) {
    return this.taskRecovery.resume(runtime);
  }
  lookupTaskStartCause(principalId: string, raw: ImmutableDelivery) {
    const cause = this.lookupToolInputCause(principalId, raw);
    return cause && 'taskId' in cause ? cause : null;
  }

  /** Private composition lookup: exact persisted Task/message input, never dispatches. */
  lookupToolInputCause(principalId: string, raw: ImmutableDelivery) {
    return this.store.fenced(() =>
      lookupEvidenceCause({
        store: this.store,
        recovery: this.taskRecovery,
        raw,
        authorize: () => {
          this.authorize(principalId, 'read');
        },
        deliveryAuthorized: (intent) => this.deliveryAuthority.deliveryAuthorized(intent),
      })
    );
  }

  /** Exact input policy for ordinary child delegation; no model field is authority. */
  allowsOrdinarySubagent(principalId: string, raw: ImmutableDelivery): boolean {
    return this.store.fenced(() =>
      ordinarySubagentAllowed({
        store: this.store,
        recovery: this.taskRecovery,
        raw,
        memberCount: this.state().members.length,
        authorize: () => {
          this.authorize(principalId, 'read');
        },
        deliveryAuthorized: (intent) => this.deliveryAuthority.deliveryAuthorized(intent),
      })
    );
  }
  /** Private native feature capability: actual member, original input and current DO policy. */
  withNativeMemberActionAuthority<T>(input: NativeMemberActionRequest, callback: () => T): T {
    return this.store.fenced(() =>
      withNativeMemberActionAuthority(
        {
          ...input,
          state: this.state(),
          store: this.store,
          grant: this.authorize(input.proof.principalId, 'read'),
          runtimeBindings: this.runtimeBindings,
        },
        callback
      )
    );
  }

  captureNativeMcpAuthority(
    principalId: string,
    source: RuntimeMemberBinding,
    raw: ImmutableDelivery,
    requireLead: boolean
  ) {
    return this.store.fenced(() =>
      captureNativeMcpAuthority({
        principalId,
        source,
        raw,
        requireLead,
        store: this.store,
        members: this.state().members,
        grant: this.authorize(principalId, 'read'),
        lookupCause: () =>
          lookupEvidenceCause({
            store: this.store,
            recovery: this.taskRecovery,
            raw,
            authorize: () => {
              this.authorize(principalId, 'read');
            },
            deliveryAuthorized: (intent) => this.deliveryAuthority.deliveryAuthorized(intent),
          }),
      })
    );
  }
  /** Trusted composition reads the launch-owned current technical selection, never native tokens. */
  runtimeSelection(principalId: string, memberId: string) {
    return this.store.fenced(() => {
      this.authorize(principalId, 'read');
      const member = this.state().members.find((item) => item.memberId === memberId);
      if (!member?.delivery) throw new TeamOwnerError('invalid');
      return this.runtimeBindings?.current(memberBinding(member.delivery));
    });
  }

  /** Trusted aggregate lifecycle composition only; no async work is allowed inside this fence. */
  withLaunchAuthority<T>(
    principalId: string,
    action: 'read' | 'control',
    callback: (authorityRevision: number) => T
  ): T {
    return this.store.fenced(() => {
      const grant = this.authorize(principalId, action === 'read' ? 'read' : 'admin');
      return callback(grant.revision ?? 1);
    });
  }

  authorizeRuntimeAccess(
    principalId: string,
    binding: RuntimeMemberBinding,
    action: 'read' | 'control'
  ): boolean {
    return this.deliveryAuthority.runtimeAccess(principalId, binding, action);
  }
  authorizeMemberBinding(
    binding: RuntimeMemberBinding,
    action: 'read' | 'admit' | 'dispatch' | 'control'
  ): boolean {
    return this.deliveryAuthority.authorizeMember(binding, action);
  }
  authorizeDeliveryIntent(
    raw: ImmutableDelivery,
    action: 'read' | 'admit' | 'dispatch' | 'control' = 'admit'
  ): boolean {
    return this.deliveryAuthority.authorizeIntent(raw, action);
  }

  private finishBootstrap(state: OwnerState): void {
    const expected = {
      name: this.binding.teamName,
      ...(state.savedSettings === undefined ? {} : { savedSettings: state.savedSettings }),
      members: state.members.map((member) => ({
        ...member.settings,
        name: member.name,
        ...(member.settings === undefined ? {} : { role: member.role }),
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
    validateTeamText(principalId);
    return Object.freeze({
      execute: (command: TeamCommand) => this.execute(principalId, command),
      lookup: (commandId: string, expected?: TeamCommand) => this.lookupCommand(principalId, commandId, expected),
      getTask: (taskId: string) => this.getTask(principalId, taskId),
      listTasks: () => this.listTasks(principalId),
      readSnapshot: () => this.readSnapshot(principalId),
      readDeletedTasks: () => this.readDeletedTasks(principalId),
      ...(this.policy.reads
        ? {
            readQueries: createTeamReadQueries({
              reads: this.policy.reads,
              fenced: (action) => this.store.fenced(action),
              authority: () => ({
                grant: this.authorize(principalId, 'read'),
                members: this.state().members,
              }),
              getTeam: () => this.readSnapshot(principalId),
            }),
          }
        : {}),
      readChanges: (cursor?: string) => this.readChanges(principalId, cursor),
      pendingDeliveries: () => this.pendingDeliveries(principalId),
      revoke: (target: string) => this.revoke(principalId, target),
      readRoster: () => this.roster.read(principalId),
      replaceRoster: (input: ReplaceTeamRoster) => this.roster.replace(principalId, input),
      lookupRoster: (commandId: string, expected?: Omit<ReplaceTeamRoster, 'commandId'>) =>
        this.roster.lookup(principalId, commandId, expected),
    });
  }

  /** Recovery reads verify the exact original command; they never execute or recapture it. */
  private lookupCommand(principalId: string, commandId: string, expected?: TeamCommand) {
    if (expected) validateTeamCommand(expected);
    return this.withLaunchAuthority(principalId, 'read', () => {
      const receipt = lookupOwnedProductCommand(this.store, principalId, commandId);
      if (receipt && digest(receipt.binding) !== digest(this.binding)) throw new TeamOwnerError('hold');
      if (!expected || !receipt) return receipt;
      const grant = this.authorize(principalId, expected.operation === 'message.send' ? 'message.write' : 'task.write');
      if (requiresHumanTaskActor(expected) && grant.memberName !== 'user') throw new TeamOwnerError('forbidden');
      if (expected.commandId !== commandId || digest(receipt.binding) !== digest(this.binding) ||
        digest(receipt.command) !== digest(expected)) throw new TeamOwnerError('conflict');
      if (teamCommandFingerprint(receipt) !== receipt.fingerprint) throw new TeamOwnerError('hold');
      const selection = captureCommandSelection(expected, receipt, this.state().members, grant);
      if (teamCommandFingerprint({ binding: this.binding, principalId, command: expected,
        deliveryBinding: selection.deliveryBinding, taskRecipients: selection.taskRecipients,
        messageRecipientRole: selection.messageRecipientRole, taskStartLeadName: selection.taskStartLeadName }) !== receipt.fingerprint)
        throw new TeamOwnerError('conflict');
      if (receipt.messageRecipientRole !== undefined && receipt.messageRecipientRole !== selection.messageRecipient?.role)
        throw new TeamOwnerError('hold');
      // Exact recovery still requires the current original attachment and authority checks.
      validateCommandAttachments(expected, this.policy.attachments);
      return receipt;
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
    this.runtimeRegistration?.validate(state);
    this.roster.recover(state);
    return {
      ...state,
      members: state.members.map((member) => {
        const selection =
          member.delivery && this.runtimeBindings?.current(memberBinding(member.delivery));
        return selection
          ? {
              ...member,
              delivery: { ...member.delivery!, ...selection.binding },
            }
          : member;
      }),
    };
  }

  private authorize(principalId: string, permission: TeamGrant['permissions'][number]): TeamGrant {
    const state = this.state();
    if (permission === 'task.write' || permission === 'message.write')
      assertTeamExecutionAllowed(state, this.store);
    const grant = state.grants.find((entry) => entry.principalId === principalId);
    if (!grant || grant.revoked || !grant.permissions.includes(permission))
      throw new TeamOwnerError('forbidden');
    return grant;
  }

  private taskAuthorityCurrent(receipt: CommandReceipt): boolean {
    try {
      const grant = this.authorize(receipt.principalId, 'task.write');
      this.authorize(receipt.principalId, 'read');
      const current = readProductCommand(this.store, receipt.commandId);
      return (
        receipt.command.operation !== 'message.send' &&
        (!requiresHumanTaskActor(receipt.command) || grant.memberName === 'user') &&
        (!isUserTaskStartIntent(receipt.command) ||
          receipt.taskStartLeadName ===
            this.state().members.find((member) => member.role === 'lead')?.name) &&
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
            taskStartLeadName: receipt.taskStartLeadName,
          })
      );
    } catch {
      return false;
    }
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
      this.productChanges.invalidate();
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

  private readDeletedTasks(principalId: string): JsonValue {
    return this.store.fenced(() => {
      this.authorize(principalId, 'read');
      const value = json({
        kind: 'deleted-tasks',
        teamName: this.binding.teamName,
        tasks: this.policy.taskBoard().listDeletedTasks(),
      });
      if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new TeamOwnerError('hold');
      return value;
    });
  }

  /** Product read under the current actor grant and the same fence as revoke/writes. */
  private productSnapshot(principalId: string) {
    const grant = this.authorize(principalId, 'read');
    const state = this.state();
    const members = state.members.map(({ name, role }) => ({ name, role }));
    const recipients = grant.permissions.includes('admin')
      ? [...members.map(({ name }) => name), 'user']
      : [grant.memberName];
    const snapshot = {
      teamName: this.binding.teamName,
      lifecycle: this.commandAccess.lifecycle(principalId).view(),
      configurationRevision: teamRosterRevision(
        state.members,
        state.rosterVersion,
        state.savedSettings
      ),
      // Retained captures and original bindings survive roster changes and Host restart.
      // Only their complete absence proves this owner has no native launch obligations.
      ...(state.runtimeNeverLaunched === true &&
      !state.runtimeCaptures?.length &&
      ![...state.members, ...(state.removedMembers ?? [])].some((member) => member.delivery) &&
      !state.lifecycle?.cleanupPending
        ? { runtimeNeverLaunched: true }
        : {}),
      members,
      tasks: this.policy.taskBoard().listTasks(),
      ...(this.policy.processes ? { processes: this.processCommands(principalId).list() } : {}),
      messages: projectCrossTeamMessages({
        store: this.store,
        policy: this.policy,
        messages: canonicalGroupMessages(recipients.flatMap((name) => this.policy.readInbox(name))),
        actor: grant.memberName,
        readAll: grant.permissions.includes('admin'),
      }),
      kanbanState: this.store.read('../kanban-state.json') ?? {
        teamName: this.binding.teamName,
        reviewers: [],
        tasks: {},
      },
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 512 * 1024) throw new TeamOwnerError('hold');
    return { ...snapshot, revision: digest(snapshot) };
  }

  private readSnapshot(principalId: string): JsonValue {
    return this.store.fenced(() => {
      const snapshot = this.productSnapshot(principalId);
      const value = json({
        ...snapshot,
        feed: this.productChanges.snapshot(principalId, snapshot.revision),
      });
      if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new TeamOwnerError('hold');
      return value;
    });
  }

  private readChanges(principalId: string, cursor?: string): JsonValue {
    return this.store.fenced(() => {
      const snapshot = this.productSnapshot(principalId);
      return json(this.productChanges.read(principalId, snapshot.revision, cursor));
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

  readTaskInputCause(principalId: string, raw: ImmutableDelivery) {
    return this.withLaunchAuthority(principalId, 'read', () =>
      lookupRetainedTaskStartCause({
        store: this.store,
        recovery: this.taskRecovery,
        raw,
      })
    );
  }
  readCrossTeamReplyHints(principalId: string, active: readonly ImmutableDelivery[]) {
    return this.withLaunchAuthority(principalId, 'read', () =>
      readCrossTeamReplyHints({
        store: this.store,
        active,
        authorizeOriginal: (raw) => this.deliveryAuthority.authorizeIntent(raw, 'read'),
      })
    );
  }
  /** Private paired authority only; absent from connect/MCP ordinary message dispatch. */
  receiveCrossTeam(principalId: string, intent: CapturedCrossTeamIntent): CommandReceipt {
    return this.execute(principalId, crossTeamTargetCommand(intent), structuredClone(intent));
  }
  /** New admission captures this grant and roster once. */
  crossTeamIdentity(principalId: string, write = false) {
    return this.store.fenced(() => {
      this.authorize(principalId, 'read');
      const grant = this.authorize(principalId, write ? 'message.write' : 'read');
      return structuredClone({
        actor: grant.memberName,
        revision: grant.revision ?? 1,
        members: this.state().members,
      });
    });
  }
  private execute(
    principalId: string,
    rawCommand: TeamCommand,
    crossTeam?: CapturedCrossTeamIntent,
    group?: CapturedGroupIntent
  ): CommandReceipt {
    return executeTeamCommand(
      {
        binding: this.binding,
        store: this.store,
        policy: this.policy,
        taskRecovery: this.taskRecovery,
        assertTaskGroupAssociation: (principal, groupChatId) =>
          this.commandAccess.groups.assertTaskAssociation(principal, groupChatId),
        state: () => this.state(),
        authorize: (principal, permission) => this.authorize(principal, permission),
        crossTeamOriginalAuthorized: (intent) =>
          this.deliveryAuthority.crossTeamOriginalAuthorized(intent),
        invalidate: () => this.productChanges.invalidate(),
      },
      principalId,
      rawCommand,
      crossTeam,
      group
    );
  }
}
