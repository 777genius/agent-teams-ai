import { TeamOwnerError } from './contracts.js';
import { digest, effectId } from './identity.js';
import { memberBinding } from './DeliveryRecovery.js';
import { teamRosterRevision } from './rosterSchema.js';
import { assertTeamExecutionAllowed } from './teamLifecycleAdmission.js';
import { nativeMemberCreationSchema } from './nativeMemberCreationContracts.js';
import type { JsonValue } from '../contracts.js';
import type { TeamBinding, TeamGrant } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamStore } from './ports.js';
import type { StoredRosterReceipt } from './rosterContracts.js';
import type {
  NativeMemberCreationAuthority,
  NativeMemberCreationInput,
  NativeMemberCreationRecord,
  NativeMemberCreationView,
} from './nativeMemberCreationContracts.js';

type CreationReceipt = StoredRosterReceipt & {
  nativeCreation: NativeMemberCreationRecord;
};
type CreationState = OwnerState & {
  rosterCommands?: (StoredRosterReceipt & {
    nativeCreation?: NativeMemberCreationRecord;
  })[];
};
const revision = (state: OwnerState) =>
  teamRosterRevision(state.members, state.rosterVersion, state.savedSettings);

/** Additive live membership: existing members, delivery bindings, grants and queues never change. */
export class TeamNativeMemberCreation {
  constructor(
    private readonly options: {
      binding: TeamBinding;
      store: TeamStore;
      state(): OwnerState;
      authorize(principalId: string, permission: 'read' | 'admin'): TeamGrant;
      validate(state: OwnerState): void;
      project(state: OwnerState, previous: JsonValue): JsonValue;
      recover(state: OwnerState): void;
      invalidate(): void;
    }
  ) {}

  private authorize(state: CreationState, source: NativeMemberCreationAuthority): void {
    source.assertTeamCurrent();
    const proof = source.team,
      actor = state.members.find((row) => row.memberId === proof.actorId);
    const grant = state.grants.find((row) => row.principalId === proof.principalId);
    if (
      !actor?.delivery ||
      actor.role !== 'lead' ||
      proof.role !== 'lead' ||
      proof.mode !== 'do' ||
      !grant ||
      grant.revoked ||
      grant.memberName !== actor.name ||
      grant.memberName === 'user' ||
      !grant.permissions.includes('read') ||
      !grant.permissions.includes('task.write') ||
      (grant.revision ?? 1) !== proof.authorityRevision ||
      digest(memberBinding(actor.delivery)) !== digest(memberBinding(proof.source)) ||
      proof.source.backendId !== this.options.binding.backendId ||
      proof.source.teamId !== this.options.binding.teamId ||
      !/^[a-f0-9]{64}$/.test(source.fingerprint)
    )
      throw new TeamOwnerError('forbidden');
    assertTeamExecutionAllowed(state, this.options.store);
  }
  private fingerprint(source: NativeMemberCreationAuthority, input: NativeMemberCreationInput) {
    return digest({
      binding: this.options.binding,
      principalId: source.team.principalId,
      operation: 'native.member.add',
      inputAuthority: source.fingerprint,
      input,
    });
  }
  /** Trusted cold metadata composition only; never admits or resumes the recorded native action. */
  retained(principalId: string): CreationReceipt[] {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      this.options.authorize(principalId, 'admin');
      const state = this.options.state() as CreationState;
      this.options.validate(state);
      return structuredClone(
        (state.rosterCommands ?? []).filter(
          (row): row is CreationReceipt => row.nativeCreation !== undefined
        )
      );
    });
  }
  private view(row: CreationReceipt): NativeMemberCreationView {
    return {
      commandId: row.commandId,
      memberId: row.nativeCreation.member.memberId,
      name: row.nativeCreation.member.name,
      revision: row.revision,
      phase: row.nativeCreation.phase,
    };
  }
  private find(
    state: CreationState,
    source: NativeMemberCreationAuthority,
    input: NativeMemberCreationInput
  ): CreationReceipt | undefined {
    const row = state.rosterCommands?.find((item) => item.commandId === input.commandId);
    if (!row) return undefined;
    if (
      !row.nativeCreation ||
      row.principalId !== source.team.principalId ||
      row.fingerprint !== this.fingerprint(source, input)
    )
      throw new TeamOwnerError('conflict');
    return row as CreationReceipt;
  }
  /** Returns original metadata on duplicate. The caller MUST NOT resume a prior prepared effect. */
  begin(
    source: NativeMemberCreationAuthority,
    raw: NativeMemberCreationInput
  ): { fresh: boolean; value: NativeMemberCreationView } {
    const parsed = nativeMemberCreationSchema.safeParse(raw);
    if (!parsed.success) throw new TeamOwnerError('invalid');
    const input = structuredClone(parsed.data);
    source.assertCurrent();
    return this.options.store.fenced(() => {
      const state = this.options.state() as CreationState;
      this.options.validate(state);
      this.authorize(state, source);
      const prior = this.find(state, source, input);
      if (prior) return { fresh: false, value: this.view(prior) };
      if (
        this.options.store.read(`commands/${digest(input.commandId)}.json`) ||
        state.runtimeCaptures?.some((row) => row.commandId === input.commandId)
      )
        throw new TeamOwnerError('conflict');
      if (revision(state) !== input.expectedRosterRevision) throw new TeamOwnerError('conflict');
      if (
        !state.savedSettings ||
        state.members.length >= 256 ||
        (state.rosterCommands?.length ?? 0) >= 1024 ||
        state.rosterCommands?.some(
          (row) => row.nativeCreation && !['completed', 'held'].includes(row.nativeCreation.phase)
        )
      )
        throw new TeamOwnerError('hold');
      const { name, ...settings } = input.member;
      if (
        ['user', 'team-lead'].includes(name.toLowerCase()) ||
        [...state.members, ...(state.removedMembers ?? [])].some(
          (row) => row.name.toLowerCase() === name.toLowerCase()
        )
      )
        throw new TeamOwnerError('conflict');
      const next = structuredClone(state),
        member = {
          memberId: effectId('roster-member', this.options.binding.teamId, input.commandId, name),
          name,
          role: 'member' as const,
          settings,
        };
      next.members.push(member);
      next.rosterVersion = (next.rosterVersion ?? 0) + 1;
      const nativeCreation: NativeMemberCreationRecord = {
        schemaVersion: 1,
        phase: 'prepared',
        expectedRosterRevision: input.expectedRosterRevision,
        input,
        source: structuredClone(source.team),
        inputAuthority: source.fingerprint,
        member,
      };
      const row: CreationReceipt = {
        commandId: input.commandId,
        principalId: source.team.principalId,
        fingerprint: this.fingerprint(source, input),
        revision: revision(next),
        nativeCreation,
      };
      next.rosterCommands = [...(next.rosterCommands ?? []), row];
      this.publish(next, true);
      return { fresh: true, value: this.view(row) };
    });
  }
  /** Captured recipe publication only: no provider allocation or asynchronous work under Team's fence. */
  configure(
    source: NativeMemberCreationAuthority,
    input: NativeMemberCreationInput,
    selection: NonNullable<NativeMemberCreationRecord['selection']>
  ): NativeMemberCreationView {
    source.assertCurrent();
    return this.options.store.fenced(() => {
      const state = this.options.state() as CreationState;
      this.options.validate(state);
      this.authorize(state, source);
      const prior = this.find(state, source, input);
      if (!prior || prior.nativeCreation.phase !== 'prepared') throw new TeamOwnerError('hold');
      if (revision(state) !== prior.revision) throw new TeamOwnerError('conflict');
      const { delivery } = selection;
      if (
        delivery.backendId !== this.options.binding.backendId ||
        delivery.teamId !== this.options.binding.teamId ||
        delivery.teamName !== this.options.binding.teamName ||
        delivery.memberId !== prior.nativeCreation.member.memberId ||
        delivery.runId !== source.team.source.runId ||
        !delivery.generation ||
        !selection.principalId ||
        state.grants.some((row) => row.principalId === selection.principalId) ||
        !/^[a-f0-9]{64}$/.test(selection.configurationDigest)
      )
        throw new TeamOwnerError('forbidden');
      const next = structuredClone(state),
        row = this.find(next, source, input)!;
      const member = next.members.find((item) => item.memberId === delivery.memberId);
      if (!member || member.delivery || digest(member) !== digest(row.nativeCreation.member))
        throw new TeamOwnerError('conflict');
      delete next.runtimeNeverLaunched;
      member.delivery = structuredClone(delivery);
      next.grants.push({
        principalId: selection.principalId,
        memberName: member.name,
        permissions: ['read', 'task.write', 'message.write', 'process.write'],
        revision: 1,
      });
      row.nativeCreation.selection = structuredClone(selection);
      row.nativeCreation.phase = 'configured';
      this.publish(next, false);
      return this.view(row);
    });
  }
  settle(
    source: NativeMemberCreationAuthority,
    input: NativeMemberCreationInput,
    phase: 'completed' | 'held'
  ): NativeMemberCreationView {
    source.assertCurrent();
    return this.options.store.fenced(() => {
      const state = this.options.state() as CreationState;
      this.options.validate(state);
      this.authorize(state, source);
      const next = structuredClone(state),
        row = this.find(next, source, input);
      if (
        !row ||
        !['prepared', 'configured'].includes(row.nativeCreation.phase) ||
        (phase === 'completed' && row.nativeCreation.phase !== 'configured')
      )
        throw new TeamOwnerError('hold');
      row.nativeCreation.phase = phase;
      this.publish(next, false);
      return this.view(row);
    });
  }
  /** Original expected member admission, before TeamLaunch publication and model preflight. */
  withPrepared<T>(
    source: NativeMemberCreationAuthority,
    input: NativeMemberCreationInput,
    operation: () => T
  ): T {
    source.assertCurrent();
    return this.options.store.fenced(() => {
      const state = this.options.state() as CreationState;
      this.options.validate(state);
      this.authorize(state, source);
      const row = this.find(state, source, input);
      if (!row || row.nativeCreation.phase !== 'prepared' || revision(state) !== row.revision)
        throw new TeamOwnerError('hold');
      return operation();
    });
  }
  /** Allocation admission only, ending at the original Runtime claim; never a target lifetime grant. */
  withConfigured<T>(
    source: NativeMemberCreationAuthority,
    input: NativeMemberCreationInput,
    operation: () => T
  ): T {
    source.assertCurrent();
    return this.options.store.fenced(() => {
      const state = this.options.state() as CreationState;
      this.options.validate(state);
      this.authorize(state, source);
      const row = this.find(state, source, input),
        selection = row?.nativeCreation.selection;
      const member =
        selection && state.members.find((item) => item.memberId === selection.delivery.memberId);
      const grant =
        selection && state.grants.find((item) => item.principalId === selection.principalId);
      if (
        !row ||
        row.nativeCreation.phase !== 'configured' ||
        revision(state) !== row.revision ||
        !member?.delivery ||
        digest(member.delivery) !== digest(selection!.delivery) ||
        !grant ||
        grant.revoked ||
        grant.memberName !== member.name ||
        !grant.permissions.includes('read') ||
        !grant.permissions.includes('task.write')
      )
        throw new TeamOwnerError('hold');
      return operation();
    });
  }
  lookup(
    source: NativeMemberCreationAuthority,
    raw: NativeMemberCreationInput
  ): NativeMemberCreationView | null {
    const parsed = nativeMemberCreationSchema.safeParse(raw);
    if (!parsed.success) throw new TeamOwnerError('invalid');
    return this.options.store.fenced(() => {
      const state = this.options.state() as CreationState;
      this.options.validate(state);
      this.authorize(state, source);
      const row = this.find(state, source, parsed.data);
      return row ? this.view(row) : null;
    });
  }
  private publish(state: CreationState, product: boolean): void {
    if (product) {
      const before = this.options.store.read<JsonValue>('../config.json');
      if (!before || typeof before !== 'object' || Array.isArray(before))
        throw new TeamOwnerError('hold');
      state.rosterProjection = {
        before,
        after: this.options.project(state, before),
      };
    }
    if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) throw new TeamOwnerError('hold');
    this.options.validate(state);
    this.options.store.write('state.json', state);
    this.options.invalidate();
    this.options.recover(state);
  }
}
