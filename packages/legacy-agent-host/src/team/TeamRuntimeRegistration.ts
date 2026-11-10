import { assertTeamExecutionAllowed } from './teamLifecycleAdmission.js';
import { listTeamCommandEntries } from './commandEntries.js';
import { z } from 'zod';

import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { teamRosterRevision } from './rosterSchema.js';

import type {
  DeliveryIntent,
  RuntimeMemberBinding,
  TeamBinding,
  TeamGrant,
  TeamMember,
} from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamStore } from './ports.js';
import type {
  RegisterTeamRuntime,
  StoredTeamRuntimeCapture,
  TeamRuntimeCapture,
  TeamRuntimeRegistrationReceipt,
} from './runtimeRegistrationContracts.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !!value.trim() && !value.includes('\0'));
const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const delivery = z
  .object({
    backendId: segment,
    teamId: segment,
    teamName: segment,
    runId: id,
    memberId: segment,
    generation: id,
  })
  .strict();
const member = z.object({ memberId: segment, principalId: id, delivery }).strict();
const registration = z
  .object({
    commandId: id,
    expectedRevision: hash,
    launchId: id,
    members: z.array(member).min(1).max(256),
  })
  .strict();
const storedCapture = z
  .object({
    commandId: id,
    configurationRevision: hash,
    launchId: id,
    members: z.array(member).min(1).max(256),
    principalId: id,
    fingerprint: hash,
  })
  .strict();
const receipt = ({
  commandId,
  configurationRevision,
  launchId,
}: TeamRuntimeCapture): TeamRuntimeRegistrationReceipt => ({
  commandId,
  configurationRevision,
  launchId,
});
const capture = (value: StoredTeamRuntimeCapture): TeamRuntimeCapture => ({
  ...receipt(value),
  members: structuredClone(value.members),
});

/** Trusted native registration publishes only Team identities/grants, never provider recipes. */
export class TeamRuntimeRegistration {
  constructor(
    private readonly options: {
      binding: TeamBinding;
      store: TeamStore;
      state(): OwnerState;
      authorize(principalId: string, permission: 'read' | 'admin'): TeamGrant;
      assertEditable(members: readonly TeamMember[]): void;
      hasRuntimeProof: boolean;
      invalidate(): void;
    }
  ) {}

  register(principalId: string, raw: RegisterTeamRuntime): TeamRuntimeRegistrationReceipt {
    const parsed = registration.safeParse(raw);
    if (!parsed.success) throw new TeamOwnerError('invalid');
    const input = structuredClone(parsed.data),
      fingerprint = this.fingerprint(principalId, input);
    const captured = this.admission(principalId, input, fingerprint);
    if (captured.prior) return captured.prior;
    // The Runtime proof must be synchronous; no await can separate it from publication.
    return this.options.store.fenced(() => {
      const checked = this.recheck(principalId, input, fingerprint, captured);
      if (checked.prior) return checked.prior;
      const state = checked.state!;
      const next = structuredClone(state);
      const oldPrincipals = new Set(
        (state.runtimeCaptures ?? []).flatMap((item) =>
          item.members.map((member) => member.principalId)
        )
      );
      const oldDeliveryMembers = new Set(
        state.members.filter((member) => member.delivery).map((member) => member.name)
      );
      for (const grant of next.grants) {
        if (
          !grant.revoked &&
          grant.principalId !== principalId &&
          grant.memberName !== 'user' &&
          (oldPrincipals.has(grant.principalId) ||
            oldDeliveryMembers.has(grant.memberName) ||
            !grant.permissions.includes('admin'))
        ) {
          grant.revoked = true;
          grant.revision = (grant.revision ?? 1) + 1;
        }
      }
      next.members = next.members.map((member) => ({
        ...member,
        delivery: structuredClone(
          input.members.find((item) => item.memberId === member.memberId)!.delivery
        ),
      }));
      next.grants.push(
        ...input.members.map((item) => ({
          principalId: item.principalId,
          memberName: state.members.find((member) => member.memberId === item.memberId)!.name,
          permissions: [
            'read',
            'task.write',
            'message.write',
            'process.write',
          ] as TeamGrant['permissions'],
          revision: 1,
        }))
      );
      const decided: StoredTeamRuntimeCapture = {
        commandId: input.commandId,
        configurationRevision: input.expectedRevision,
        launchId: input.launchId,
        members: input.members,
        principalId,
        fingerprint,
      };
      next.runtimeCaptures = [...(state.runtimeCaptures ?? []), decided];
      delete next.runtimeNeverLaunched;
      this.validate(next);
      this.options.store.write('state.json', next);
      this.options.invalidate();
      return receipt(decided);
    });
  }

  /** Trusted launch composition preflights the same admission before asynchronous workspace effects. */
  assertRegistration(principalId: string, raw: RegisterTeamRuntime): string {
    const parsed = registration.safeParse(raw);
    if (!parsed.success) throw new TeamOwnerError('invalid');
    const input = structuredClone(parsed.data),
      fingerprint = this.fingerprint(principalId, input);
    const captured = this.admission(principalId, input, fingerprint);
    return this.options.store.fenced(() => {
      const checked = this.recheck(principalId, input, fingerprint, captured);
      return digest({
        principalId,
        fingerprint,
        admission: checked.prior ?? {
          authorityRevision: captured.authorityRevision,
          technicalRevision: captured.technicalRevision,
        },
      });
    });
  }

  private recheck(
    principalId: string,
    input: RegisterTeamRuntime,
    fingerprint: string,
    captured: ReturnType<TeamRuntimeRegistration['admission']>
  ) {
    const grant = this.options.authorize(principalId, 'admin');
    this.options.authorize(principalId, 'read');
    const state = this.options.state();
    this.validate(state);
    this.assertOtherCommandIds(state, input.commandId);
    const prior = this.replay(state, principalId, input.commandId, fingerprint);
    if (prior) return { prior };
    assertTeamExecutionAllowed(state, this.options.store);
    if (
      (grant.revision ?? 1) !== captured.authorityRevision ||
      this.technicalRevision(state) !== captured.technicalRevision
    )
      throw new TeamOwnerError('conflict');
    this.assertNew(state, input);
    this.assertNoPending();
    return { state };
  }

  private admission(principalId: string, input: RegisterTeamRuntime, fingerprint: string) {
    const captured = this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId, 'admin');
      this.options.authorize(principalId, 'read');
      const state = structuredClone(this.options.state());
      this.validate(state);
      this.assertOtherCommandIds(state, input.commandId);
      const prior = this.replay(state, principalId, input.commandId, fingerprint);
      if (prior) return { prior };
      assertTeamExecutionAllowed(state, this.options.store);
      this.assertNew(state, input);
      this.assertNoPending();
      return {
        state,
        authorityRevision: grant.revision ?? 1,
        technicalRevision: this.technicalRevision(state),
      };
    });
    if (captured.prior) return captured;
    const old = captured.state!;
    if (old.runtimeCaptures?.length && !this.options.hasRuntimeProof)
      throw new TeamOwnerError('hold');
    this.options.assertEditable(structuredClone(old.members));
    return captured;
  }

  all(principalId: string): TeamRuntimeCapture[] {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const state = this.options.state();
      this.validate(state);
      return (state.runtimeCaptures ?? []).map(capture);
    });
  }

  current(principalId: string): TeamRuntimeCapture | undefined {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const state = this.options.state();
      this.validate(state);
      const revision = teamRosterRevision(state.members, state.rosterVersion, state.savedSettings);
      const selected = state.runtimeCaptures?.findLast(
        (item) => item.configurationRevision === revision
      );
      return selected ? capture(selected) : undefined;
    });
  }

  has(principalId: string, binding: RuntimeMemberBinding): boolean {
    return this.all(principalId).some((item) =>
      item.members.some(
        ({ delivery: selected }) =>
          digest({
            backendId: selected.backendId,
            teamId: selected.teamId,
            runId: selected.runId,
            memberId: selected.memberId,
            generation: selected.generation,
          }) === digest(binding)
      )
    );
  }

  validate(state: OwnerState): void {
    const rows = state.runtimeCaptures ?? [];
    if (
      !Array.isArray(rows) ||
      rows.length > 1024 ||
      Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024
    )
      throw new TeamOwnerError('hold');
    const commands = new Set<string>(),
      launches = new Set<string>(),
      principals = new Set<string>();
    for (const row of rows) {
      if (
        !storedCapture.safeParse(row).success ||
        commands.has(row.commandId) ||
        launches.has(row.launchId) ||
        row.fingerprint !==
          this.fingerprint(row.principalId, {
            commandId: row.commandId,
            expectedRevision: row.configurationRevision,
            launchId: row.launchId,
            members: row.members,
          })
      )
        throw new TeamOwnerError('hold');
      commands.add(row.commandId);
      launches.add(row.launchId);
      const ids = new Set<string>();
      for (const member of row.members) {
        if (
          ids.has(member.memberId) ||
          principals.has(member.principalId) ||
          !this.matchesDelivery(member, row.launchId)
        )
          throw new TeamOwnerError('hold');
        ids.add(member.memberId);
        principals.add(member.principalId);
      }
    }
  }

  private fingerprint(principalId: string, input: RegisterTeamRuntime): string {
    return digest({
      binding: this.options.binding,
      principalId,
      operation: 'runtime.register',
      input,
    });
  }
  private technicalRevision(state: OwnerState): string {
    return digest({
      members: state.members,
      grants: state.grants,
      captures: state.runtimeCaptures ?? [],
    });
  }
  private matchesDelivery(
    member: RegisterTeamRuntime['members'][number],
    launchId: string
  ): boolean {
    const selected = member.delivery,
      binding = this.options.binding;
    return (
      selected.backendId === binding.backendId &&
      selected.teamId === binding.teamId &&
      selected.teamName === binding.teamName &&
      selected.memberId === member.memberId &&
      selected.runId === launchId
    );
  }
  private assertOtherCommandIds(state: OwnerState, commandId: string): void {
    if (
      state.rosterCommands?.some((item) => item.commandId === commandId) ||
      this.options.store.read(`commands/${digest(commandId)}.json`)
    )
      throw new TeamOwnerError('conflict');
  }
  private replay(
    state: OwnerState,
    principalId: string,
    commandId: string,
    fingerprint: string
  ): TeamRuntimeRegistrationReceipt | undefined {
    const prior = state.runtimeCaptures?.find((item) => item.commandId === commandId);
    if (!prior) return undefined;
    if (prior.principalId !== principalId || prior.fingerprint !== fingerprint)
      throw new TeamOwnerError('conflict');
    return receipt(prior);
  }
  private assertNew(state: OwnerState, input: RegisterTeamRuntime): void {
    if (
      teamRosterRevision(state.members, state.rosterVersion, state.savedSettings) !==
      input.expectedRevision
    )
      throw new TeamOwnerError('conflict');
    if ((state.runtimeCaptures?.length ?? 0) >= 1024) throw new TeamOwnerError('hold');
    if (
      state.runtimeCaptures?.some((item) => item.launchId === input.launchId) ||
      [...state.members, ...(state.removedMembers ?? [])].some(
        (member) => member.delivery?.runId === input.launchId
      )
    )
      throw new TeamOwnerError('conflict');
    if (
      input.members.length !== state.members.length ||
      new Set(input.members.map((member) => member.memberId)).size !== state.members.length ||
      state.members.some(
        (member) => !input.members.some((item) => item.memberId === member.memberId)
      ) ||
      new Set(input.members.map((member) => member.principalId)).size !== input.members.length ||
      input.members.some((member) => !this.matchesDelivery(member, input.launchId))
    )
      throw new TeamOwnerError('invalid');
    if (
      input.members.some(
        (member) =>
          state.grants.some((grant) => grant.principalId === member.principalId) ||
          state.runtimeCaptures?.some((row) =>
            row.members.some((prior) => prior.principalId === member.principalId)
          )
      )
    )
      throw new TeamOwnerError('conflict');
  }
  private assertNoPending(): void {
    if (
      listTeamCommandEntries(this.options.store).some(
        (item) => !['completed', 'rejected'].includes(item.phase)
      ) ||
      this.options.store.list<DeliveryIntent>('outbox').some((item) => {
        if (!['pending', 'admitted', 'not_admitted'].includes(item.phase))
          throw new TeamOwnerError('hold');
        return item.phase === 'pending';
      })
    )
      throw new TeamOwnerError('hold');
  }
}
