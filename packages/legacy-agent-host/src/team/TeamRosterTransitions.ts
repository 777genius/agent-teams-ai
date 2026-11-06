import { nativeRosterSuccessor } from './nativeRosterSuccessor.js';
import { TeamNativeMemberCreation } from './TeamNativeMemberCreation.js';
import { validateNativeMemberCreationRecords } from './validateNativeMemberCreation.js';
import { assertTeamExecutionAllowed } from './teamLifecycleAdmission.js';
import { listTeamCommandEntries } from './commandEntries.js';
import { TeamOwnerError } from './contracts.js';
import {
  memberSettingsFingerprint,
  validateMemberSettingsRelaunch,
} from './memberSettingsRelaunch.js';
import { digest, effectId } from './identity.js';
import {
  memberSettingsSchema,
  replaceRosterSchema,
  replaceRosterPayloadSchema,
  savedTeamSettingsSchema,
  teamRosterRevision,
} from './rosterSchema.js';
import type { JsonValue } from '../contracts.js';
import type { DeliveryIntent, TeamBinding, TeamGrant, TeamMember } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamStore } from './ports.js';
import type {
  ReplaceTeamRoster,
  TeamRosterConfiguration,
  TeamRosterReceipt,
} from './rosterContracts.js';

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
export function controllerProjection(state: OwnerState, previous: JsonValue): JsonValue {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous))
    throw new TeamOwnerError('hold');
  const metadata = { ...previous };
  if (state.lifecycle) {
    if (state.lifecycle.deletedAt) metadata.deletedAt = state.lifecycle.deletedAt;
    else delete metadata.deletedAt;
  }
  return json({
    ...metadata,
    name: state.binding.teamName,
    ...(state.savedSettings === undefined ? {} : { savedSettings: state.savedSettings }),
    members: state.members.map((member) => ({
      ...member.settings,
      name: member.name,
      // A descriptive saved role must not become controller lead authority.
      role: member.role,
      agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
    })),
  });
}

/** Team's saved-roster use case. All publication uses its existing authority fence/state. */
export class TeamRosterTransitions {
  constructor(
    private readonly options: {
      binding: TeamBinding;
      store: TeamStore;
      state(): OwnerState;
      authorize(principalId: string, permission: 'read' | 'admin'): TeamGrant;
      /** Synchronous composition proof outside Team's lock; never allocates/stops anything. */
      assertEditable(members: readonly TeamMember[]): void;
      invalidate(): void;
    }
  ) {}

  capturedMemberCurrent(principalId: string, expectedRevision: string, expected: Pick<TeamMember, 'memberId' | 'name' | 'role' | 'settings' | 'delivery'>, savedSettings?: OwnerState['savedSettings']): boolean {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const state = this.options.state(); this.validate(state);
      return nativeRosterSuccessor(state, expectedRevision, expected, savedSettings);
    });
  }

  /** Private additive native capability; same state, CAS, publication and receipts. */
  nativeCreation(): TeamNativeMemberCreation {
    return new TeamNativeMemberCreation({ ...this.options, validate: state => this.validate(state),
      project: controllerProjection, recover: state => this.recover(state) });
  }

  /** Resume only this already-decided config projection; never rerun membership policy. */
  recover(state: OwnerState): void {
    if (!state.rosterProjection) return;
    this.validate(state);
    const { before, after } = state.rosterProjection;
    const current = this.options.store.read<unknown>('../config.json');
    if (digest(current ?? null) !== digest(after)) {
      if (digest(current ?? null) !== digest(before)) throw new TeamOwnerError('hold');
      this.options.store.write('../config.json', after);
    }
    delete state.rosterProjection;
    this.options.store.write('state.json', state);
    this.options.invalidate();
  }

  read(principalId: string): TeamRosterConfiguration {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const state = this.options.state();
      this.validate(state);
      const revision = teamRosterRevision(state.members, state.rosterVersion, state.savedSettings);
      return structuredClone({
        revision,
        ...(state.savedSettings === undefined ? {} : { savedSettings: state.savedSettings }),
        members: state.members.map(({ memberId, name, role, settings }) => ({
          memberId,
          name,
          role,
          settingsFingerprint: memberSettingsFingerprint(this.options.binding, revision, memberId),
          settings: settings ?? {},
        })),
        removedMembers: (state.removedMembers ?? []).map(
          ({ memberId, name, removedAt, settings }) => ({
            memberId,
            name,
            removedAt,
            settings: settings ?? {},
          })
        ),
      });
    });
  }

  lookup(
    principalId: string,
    commandId: string,
    expected?: Omit<ReplaceTeamRoster, 'commandId'>
  ): TeamRosterReceipt | undefined {
    if (
      typeof commandId !== 'string' ||
      !commandId ||
      commandId.length > 256 ||
      commandId.includes('\0')
    )
      throw new TeamOwnerError('invalid');
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const state = this.options.state();
      this.validate(state);
      const receipt = state.rosterCommands?.find((item) => item.commandId === commandId);
      if (receipt?.principalId !== undefined && receipt.principalId !== principalId)
        throw new TeamOwnerError('forbidden');
      if (expected !== undefined) {
        const payload = replaceRosterPayloadSchema.safeParse(expected);
        if (!payload.success) throw new TeamOwnerError('invalid');
        const parsed = replaceRosterSchema.safeParse({ ...payload.data, commandId });
        if (!parsed.success) throw new TeamOwnerError('invalid');
        if (
          receipt &&
          receipt.fingerprint !== this.replacementFingerprint(principalId, parsed.data)
        )
          throw new TeamOwnerError('conflict');
      }
      return receipt ? { commandId: receipt.commandId, revision: receipt.revision } : undefined;
    });
  }

  replace(principalId: string, raw: ReplaceTeamRoster): TeamRosterReceipt {
    const parsed = replaceRosterSchema.safeParse(raw);
    if (!parsed.success) throw new TeamOwnerError('invalid');
    const input = structuredClone(parsed.data);
    const fingerprint = this.replacementFingerprint(principalId, input);
    const captured = this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId, 'admin');
      this.options.authorize(principalId, 'read');
      const state = structuredClone(this.options.state());
      this.validate(state);
      if (
        this.options.store.read(`commands/${digest(input.commandId)}.json`) ||
        state.runtimeCaptures?.some((item) => item.commandId === input.commandId)
      )
        throw new TeamOwnerError('conflict');
      const prior = this.replay(state, principalId, input.commandId, fingerprint);
      if (prior) return { prior };
      assertTeamExecutionAllowed(state, this.options.store);
      if (
        teamRosterRevision(state.members, state.rosterVersion, state.savedSettings) !==
        input.expectedRevision
      )
        throw new TeamOwnerError('conflict');
      validateMemberSettingsRelaunch(this.options.binding, state, input, input.expectedRevision);
      const members = this.members(state, input);
      const savedSettings = input.savedSettings ?? state.savedSettings;
      const changed =
        teamRosterRevision(members, state.rosterVersion, savedSettings) !== input.expectedRevision;
      if (changed) this.assertNoPendingCommands();
      return { state, members, savedSettings, changed, authorityRevision: grant.revision ?? 1 };
    });
    if (captured.prior) return captured.prior;
    if (captured.changed) this.options.assertEditable(structuredClone(captured.state!.members));
    // No await separates Runtime's proof from current authority/revision publication.
    return this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId, 'admin');
      this.options.authorize(principalId, 'read');
      const state = this.options.state();
      if (
        this.options.store.read(`commands/${digest(input.commandId)}.json`) ||
        state.runtimeCaptures?.some((item) => item.commandId === input.commandId)
      )
        throw new TeamOwnerError('conflict');
      const prior = this.replay(state, principalId, input.commandId, fingerprint);
      if (prior) return prior;
      assertTeamExecutionAllowed(state, this.options.store);
      if (
        (grant.revision ?? 1) !== captured.authorityRevision ||
        teamRosterRevision(state.members, state.rosterVersion, state.savedSettings) !==
          input.expectedRevision
      )
        throw new TeamOwnerError('conflict');
      if ((state.rosterCommands?.length ?? 0) >= 1024) throw new TeamOwnerError('hold');
      const next = structuredClone(state);
      if (captured.changed) {
        this.assertNoPendingCommands();
        const members = captured.members!;
        const removed = state.members.filter(
          (member) => !members.some((item) => item.memberId === member.memberId)
        );
        next.removedMembers = [
          ...(state.removedMembers ?? []).filter(
            (member) => !members.some((item) => item.memberId === member.memberId)
          ),
          ...removed.map((member) => ({ ...member, removedAt: new Date().toISOString() })),
        ];
        for (const grant of next.grants) {
          if (
            state.members.some(
              (member) =>
                member.name === grant.memberName && (member.delivery || removed.includes(member))
            ) &&
            !grant.revoked
          ) {
            grant.revoked = true;
            grant.revision = (grant.revision ?? 1) + 1;
          }
        }
        // Released native targets belong to the old capture, never new settings.
        next.members = members.map(({ delivery: _oldDelivery, ...member }) => member);
        if (captured.savedSettings !== undefined) next.savedSettings = captured.savedSettings;
        next.rosterVersion = (state.rosterVersion ?? 0) + 1;
        const before = this.options.store.read<JsonValue>('../config.json');
        if (!before || typeof before !== 'object' || Array.isArray(before))
          throw new TeamOwnerError('hold');
        next.rosterProjection = {
          before,
          after: controllerProjection(next, before),
        };
      }
      const receipt = {
        commandId: input.commandId,
        revision: teamRosterRevision(next.members, next.rosterVersion, next.savedSettings),
      };
      next.rosterCommands = [
        ...(state.rosterCommands ?? []),
        { ...receipt, principalId, fingerprint },
      ];
      this.validate(next);
      // Decision and original receipt are one atomic Team state publication.
      this.options.store.write('state.json', next);
      this.options.invalidate();
      this.recover(next);
      return receipt;
    });
  }

  private replacementFingerprint(principalId: string, input: ReplaceTeamRoster): string {
    return digest({
      binding: this.options.binding,
      principalId,
      operation: 'roster.replace',
      input,
    });
  }

  private replay(
    state: OwnerState,
    principalId: string,
    commandId: string,
    fingerprint: string
  ): TeamRosterReceipt | undefined {
    const prior = state.rosterCommands?.find((item) => item.commandId === commandId);
    if (!prior) return undefined;
    if (prior.principalId !== principalId || prior.fingerprint !== fingerprint)
      throw new TeamOwnerError('conflict');
    return { commandId, revision: prior.revision };
  }

  private members(state: OwnerState, input: ReplaceTeamRoster): TeamMember[] {
    const leads = state.members.filter((member) => member.role === 'lead');
    if (leads.length !== 1) throw new TeamOwnerError('hold');
    const lead = leads[0]!;
    const names = new Set([lead.name.toLowerCase(), 'user', 'team-lead']);
    return [
      lead,
      ...input.members.map(({ name, ...settings }) => {
        const suffix = name.match(/-(\d+)$/);
        if (names.has(name.toLowerCase()) || (suffix && Number(suffix[1]) >= 2))
          throw new TeamOwnerError('invalid');
        names.add(name.toLowerCase());
        const active = state.members.find(
          (member) => member.name.toLowerCase() === name.toLowerCase()
        );
        const retired = state.removedMembers?.find(
          (member) => member.name.toLowerCase() === name.toLowerCase()
        );
        const prior = active ?? retired;
        // Renames have a separate identity/history use case, never infer one from casing.
        if (prior && prior.name !== name) throw new TeamOwnerError('invalid');
        return {
          ...(active ?? {
            memberId:
              retired?.memberId ??
              effectId('roster-member', this.options.binding.teamId, input.commandId, name),
            role: 'member' as const,
          }),
          name,
          settings,
        };
      }),
    ];
  }

  private assertNoPendingCommands(): void {
    if (this.options.state().rosterCommands?.some(row => row.nativeCreation && !['completed', 'held'].includes(row.nativeCreation.phase))) throw new TeamOwnerError('hold');
    const pending = listTeamCommandEntries(this.options.store).some(
      (receipt) => !['completed', 'rejected'].includes(receipt.phase)
    );
    const delivery = this.options.store.list<DeliveryIntent>('outbox').some((intent) => {
      if (!['pending', 'admitted', 'not_admitted'].includes(intent.phase))
        throw new TeamOwnerError('hold');
      // Admission completed this Team handoff. Its cached receipt is not a
      // live input observation; the synchronous Runtime proof owns that check.
      return intent.phase === 'pending';
    });
    if (pending || delivery) throw new TeamOwnerError('hold');
  }

  private validate(state: OwnerState): void {
    validateNativeMemberCreationRecords(state);
    if (
      !Number.isSafeInteger(state.rosterVersion ?? 0) ||
      (state.rosterVersion ?? 0) < 0 ||
      (state.rosterVersion ?? 0) >= Number.MAX_SAFE_INTEGER ||
      !Array.isArray(state.members) ||
      (state.removedMembers !== undefined && !Array.isArray(state.removedMembers)) ||
      (state.rosterCommands !== undefined && !Array.isArray(state.rosterCommands)) ||
      state.members.length > 256 ||
      (state.removedMembers?.length ?? 0) > 1024 ||
      (state.rosterCommands?.length ?? 0) > 1024 ||
      (state.savedSettings !== undefined &&
        !savedTeamSettingsSchema.safeParse(state.savedSettings).success) ||
      Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024
    )
      throw new TeamOwnerError('hold');
    for (const member of [...state.members, ...(state.removedMembers ?? [])])
      if (
        !member ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(member.memberId) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(member.name) ||
        !['lead', 'member'].includes(member.role) ||
        !memberSettingsSchema.safeParse(member.settings ?? {}).success
      )
        throw new TeamOwnerError('hold');
    const all = [...state.members, ...(state.removedMembers ?? [])];
    if (
      new Set(all.map((member) => member.memberId)).size !== all.length ||
      new Set(state.members.map((member) => member.name.toLowerCase())).size !==
        state.members.length
    )
      throw new TeamOwnerError('hold');
    if (
      new Set(state.rosterCommands?.map((item) => item.commandId)).size !==
      (state.rosterCommands?.length ?? 0)
    )
      throw new TeamOwnerError('hold');
    for (const receipt of state.rosterCommands ?? [])
      if (
        !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
        !/^[a-f0-9]{64}$/.test(receipt.revision) ||
        typeof receipt.commandId !== 'string' ||
        !receipt.commandId ||
        receipt.commandId.length > 256 ||
        typeof receipt.principalId !== 'string' ||
        !receipt.principalId ||
        receipt.principalId.length > 256
      )
        throw new TeamOwnerError('hold');
    if (state.rosterProjection) {
      const { before, after } = state.rosterProjection;
      if (
        !before ||
        typeof before !== 'object' ||
        Array.isArray(before) ||
        digest(after) !== digest(controllerProjection(state, before))
      )
        throw new TeamOwnerError('hold');
    }
  }
}
