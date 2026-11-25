import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { TeamOwnerError } from './contracts.js';
import { digest, effectId } from './identity.js';
import { memberSettingsSchema, replaceRosterSchema, teamRosterRevision } from './rosterSchema.js';
import { assertTeamExecutionAllowed } from './teamLifecycleAdmission.js';
import type { JsonValue } from '../contracts.js';
import type { TeamBinding, TeamGrant, TeamMember, TeamOwnerErrorCode } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamStore } from './ports.js';
import type { LiveRosterDelta, LiveRosterMembershipRecord, LiveRosterSelection,
  ReplaceTeamRoster, StoredRosterReceipt } from './rosterContracts.js';

const id = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const memberId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const remainingMs = z.number().int().min(1).max(100_000);

/** Private Main/Host conversation; never a Renderer operation or a new command. */
export const liveRosterPrivateInputSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('capture'), remainingMs }).strict(),
  z.object({ phase: z.literal('continue'), captureDigest: hash, remainingMs }).strict(),
  z.object({ phase: z.literal('read') }).strict(),
]);
export type LiveRosterPrivateInput = z.infer<typeof liveRosterPrivateInputSchema>;

export const liveRosterCaptureViewSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: id,
  teamId: id,
  requestDigest: hash,
  expectedRevision: hash,
  launchId: id,
  sourceCaptureDigest: hash,
  captureDigest: hash,
  target: z.object({
    memberId,
    name: memberId,
    provider: z.enum(['claude', 'codex', 'opencode']),
    modelProviderId: id.nullable(),
    modelId: id,
    workspace: z.string().min(1).max(8192).refine(value => !value.includes('\0') && isAbsolute(value)),
    optionsDigest: hash,
    configurationDigest: hash,
  }).strict(),
}).strict().refine(value =>
  value.target.provider === 'opencode'
    ? value.target.modelProviderId !== null
    : value.target.modelProviderId === null
);
export type LiveRosterCaptureView = z.infer<typeof liveRosterCaptureViewSchema>;

export const liveRosterPendingViewSchema = z.object({
  commandId: id,
  requestDigest: hash,
  phase: z.enum(['pending', 'captured', 'preparing', 'published', 'compensating', 'held']),
  captureDigest: hash.nullable(),
}).strict();
export type LiveRosterPendingView = z.infer<typeof liveRosterPendingViewSchema>;

export const liveRosterResponseSchema = z.union([
  z.object({ ok: z.literal(true), liveRosterCapture: liveRosterCaptureViewSchema }).strict(),
  z.object({ ok: z.literal(true), liveRosterPending: liveRosterPendingViewSchema }).strict(),
  z.object({ ok: z.literal(true), value: z.object({ commandId: id, revision: hash }).strict() }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum(['invalid', 'conflict', 'forbidden', 'hold']),
    outcome: z.enum(['rejected', 'unknown']),
  }).strict(),
]);
export type LiveRosterResponse = z.infer<typeof liveRosterResponseSchema>;

/** The existing envelope owns binding/lease/origin parsing; this checks its finite phase join. */
export function parseLiveRosterPrivateInput(
  method: 'team.roster.replace' | 'team.roster.lookup',
  raw: unknown,
  origin?: { remainingMs: number }
): LiveRosterPrivateInput {
  const input = liveRosterPrivateInputSchema.parse(raw);
  if (
    !['team.roster.replace', 'team.roster.lookup'].includes(method) ||
    (method === 'team.roster.lookup') !== (input.phase === 'read') ||
    (origin !== undefined && (input.phase !== 'continue' || origin.remainingMs !== input.remainingMs))
  ) throw new TeamOwnerError('invalid');
  return input;
}

/** No raw recipe, key, executable, option object or public readiness flag crosses this boundary. */
export function parseLiveRosterResponse(raw: unknown): LiveRosterResponse {
  const result = liveRosterResponseSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new TeamOwnerError('hold');
  return result;
}

const deliverySchema = z.object({
  backendId: id, teamId: id, teamName: id, runId: id, memberId, generation: id,
}).strict();
const memberSchema = z.object({
  memberId, name: memberId, role: z.literal('member'),
  settings: memberSettingsSchema.optional(), delivery: deliverySchema.optional(),
}).strict().refine(value => !value.delivery || value.delivery.memberId === value.memberId);
const removedSchema = z.object({
  memberId, name: memberId, role: z.literal('member'),
  settings: memberSettingsSchema.optional(), delivery: deliverySchema.optional(), removedAt: id,
}).strict().refine(value => !value.delivery || value.delivery.memberId === value.memberId);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const deltaSchema = z.object({
  kind: z.enum(['add', 'remove', 'restore']), targetId: memberId, position: z.number().int().min(1).max(255),
  before: memberSchema.nullable(), after: memberSchema.nullable(),
  removedBefore: removedSchema.optional(), removedPosition: z.number().int().min(0).max(1023).optional(),
}).strict();
const edgeSchema = z.object({
  beforeRevision: hash, afterRevision: hash, beforeVersion: version, afterVersion: version,
  before: memberSchema.nullable(), after: memberSchema.nullable(), position: z.number().int().min(1).max(255),
  removedBefore: removedSchema.optional(), removedAfter: removedSchema.optional(),
}).strict();
const liveRecordSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(['pending', 'captured', 'preparing', 'published', 'compensating', 'held', 'completed', 'rejected']),
  input: replaceRosterSchema, requestDigest: hash, authorityRevision: z.number().int().positive().safe(),
  launchId: id, sourceCaptureDigest: hash, hostIncarnation: id, cutoff: z.number().int().positive().safe(),
  beforeVersion: version, delta: deltaSchema, peerDigest: hash, savedSettingsDigest: hash,
  capture: liveRosterCaptureViewSchema.optional(),
  selection: z.object({ principalId: id, delivery: deliverySchema, configurationDigest: hash }).strict().optional(),
  publication: edgeSchema.optional(), compensation: edgeSchema.optional(),
  rejection: z.enum(['invalid', 'conflict', 'forbidden', 'hold']).optional(),
}).strict();

export type LiveRosterReceipt = StoredRosterReceipt & { liveMembership: LiveRosterMembershipRecord };
export interface LiveRosterSource {
  launchId: string;
  sourceCaptureDigest: string;
  hostIncarnation: string;
  cutoff: number;
  /** Same first coordinator admission: writer/lease/source checks only, no Runtime I/O. */
  assertCurrent(): void;
}
export interface LiveRosterOriginal extends LiveRosterSource {
  principalId: string;
  commandId: string;
  fingerprint: string;
  requestDigest: string;
  authorityRevision: number;
}
export interface LiveRosterPreview {
  input: ReplaceTeamRoster;
  delta: LiveRosterDelta;
  authorityRevision: number;
}
const revision = (state: OwnerState) => teamRosterRevision(state.members, state.rosterVersion, state.savedSettings);
const settled = (record: LiveRosterMembershipRecord) => ['completed', 'rejected'].includes(record.phase);
const targetName = (delta: LiveRosterDelta) => (delta.before ?? delta.after)!.name;
const peers = (state: OwnerState, delta: LiveRosterDelta) => digest({
  members: state.members.filter(row => row.memberId !== delta.targetId),
  removed: (state.removedMembers ?? []).filter(row => row.memberId !== delta.targetId),
  grants: state.grants.filter(row => row.memberName !== targetName(delta)),
});

/** Uses only the already parsed original members() result; it does not invent another UI normalization. */
export function deriveLiveRosterDelta(state: OwnerState, input: ReplaceTeamRoster, desired: TeamMember[]): LiveRosterDelta | undefined {
  if (input.memberSettingsRelaunch || digest(input.savedSettings ?? state.savedSettings ?? null) !==
      digest(state.savedSettings ?? null)) return undefined;
  const added = desired.filter(row => !state.members.some(old => old.memberId === row.memberId));
  const removed = state.members.filter(row => !desired.some(next => next.memberId === row.memberId));
  if (added.length + removed.length !== 1) return undefined;
  const target = added[0] ?? removed[0]!;
  const unchanged = (members: TeamMember[]) => members.filter(row => row.memberId !== target.memberId)
    .map(row => ({ ...row, settings: row.settings ?? {} }));
  if (target.role !== 'member' || digest(unchanged(state.members)) !== digest(unchanged(desired))) return undefined;
  const position = (added.length ? desired : state.members).findIndex(row => row.memberId === target.memberId);
  if (position < 1) return undefined;
  if (removed.length) return { kind: 'remove', targetId: target.memberId, position, before: structuredClone(target), after: null };
  if (target.delivery) return undefined;
  const retired = state.removedMembers?.find(row => row.memberId === target.memberId);
  if (retired && (retired.name !== target.name || digest(retired.settings ?? {}) !== digest(target.settings ?? {})))
    return undefined;
  return { kind: retired ? 'restore' : 'add', targetId: target.memberId, position, before: null,
    after: structuredClone(target), ...(retired ? { removedBefore: structuredClone(retired),
      removedPosition: state.removedMembers!.indexOf(retired) } : {}) };
}

/** Optional extension only; old receipts retain their original validation and meaning. */
export function validateLiveRosterMembership(state: OwnerState): void {
  let unresolved = 0;
  for (const row of state.rosterCommands ?? []) {
    if (row.liveMembership === undefined) continue;
    const parsed = liveRecordSchema.safeParse(row.liveMembership);
    if (!parsed.success || row.nativeCreation || digest(parsed.data) !== digest(row.liveMembership))
      throw new TeamOwnerError('hold');
    const record = row.liveMembership, delta = record.delta;
    if (row.commandId !== record.input.commandId || row.fingerprint !== digest({
      binding: state.binding, principalId: row.principalId, operation: 'roster.replace', input: record.input,
    }) || ![delta.before?.memberId, delta.after?.memberId].includes(delta.targetId) ||
        (delta.kind === 'remove' ? !delta.before || delta.after !== null || delta.removedBefore !== undefined
          : delta.before !== null || !delta.after || delta.after.delivery !== undefined) ||
        (delta.kind === 'restore') !== (delta.removedBefore !== undefined && delta.removedPosition !== undefined) ||
        delta.removedBefore && (delta.removedBefore.memberId !== delta.targetId ||
          delta.removedBefore.name !== delta.after?.name || digest(delta.removedBefore.settings ?? {}) !== digest(delta.after?.settings ?? {})))
      throw new TeamOwnerError('hold');
    if (!settled(record)) unresolved++;
    if (delta.kind === 'add' && delta.targetId !== effectId('roster-member', state.binding.teamId,
          row.commandId, targetName(delta)) || delta.after && digest(record.input.members.find(member =>
          member.name === delta.after!.name) ?? null) !== digest({ name: delta.after.name, ...delta.after.settings }) ||
        delta.kind === 'remove' && record.input.members.some(member => member.name.toLowerCase() === targetName(delta).toLowerCase()))
      throw new TeamOwnerError('hold');
    if ((record.phase === 'rejected') !== (record.rejection !== undefined) ||
        record.phase === 'pending' && record.capture !== undefined ||
        delta.kind === 'remove' && (record.capture !== undefined || record.selection !== undefined ||
          ['captured', 'preparing', 'compensating'].includes(record.phase)) ||
        record.selection !== undefined && record.publication === undefined ||
        ['captured', 'preparing'].includes(record.phase) && !record.capture ||
        record.delta.kind !== 'remove' && ['published', 'completed'].includes(record.phase) && !record.selection ||
        ['published', 'completed', 'compensating'].includes(record.phase) && !record.publication ||
        record.phase === 'rejected' && record.publication && !record.compensation ||
        record.compensation && (!record.publication || record.phase !== 'rejected' || record.delta.kind === 'remove'))
      throw new TeamOwnerError('hold');
    if (record.capture && (record.capture.commandId !== row.commandId || record.capture.teamId !== state.binding.teamId ||
        record.capture.requestDigest !== record.requestDigest || record.capture.expectedRevision !== record.input.expectedRevision ||
        record.capture.launchId !== record.launchId || record.capture.sourceCaptureDigest !== record.sourceCaptureDigest ||
        record.capture.target.memberId !== delta.targetId || record.capture.target.name !== targetName(delta)))
      throw new TeamOwnerError('hold');
    if (record.selection && (!record.capture || record.selection.delivery.memberId !== delta.targetId ||
        record.selection.delivery.runId !== record.launchId || record.selection.delivery.backendId !== state.binding.backendId ||
        record.selection.delivery.teamId !== state.binding.teamId || record.selection.delivery.teamName !== state.binding.teamName ||
        record.selection.configurationDigest !== record.capture.target.configurationDigest)) throw new TeamOwnerError('hold');
    if (record.publication && (digest(record.publication.before) !== digest(delta.before) ||
        digest(record.publication.after) !== digest(delta.after
          ? { ...delta.after, delivery: record.selection?.delivery } : null) ||
        digest(record.publication.removedBefore ?? null) !== digest(delta.removedBefore ?? null) ||
        (delta.kind === 'remove' ? !record.publication.removedAfter ||
          digest({ ...record.publication.removedAfter, removedAt: undefined }) !== digest(delta.before)
          : record.publication.removedAfter !== undefined))) throw new TeamOwnerError('hold');
    if (record.compensation && (digest(record.compensation.before) !== digest(record.publication!.after) ||
        digest(record.compensation.after) !== digest(delta.before) ||
        record.compensation.removedBefore !== undefined ||
        digest(record.compensation.removedAfter ?? null) !== digest(delta.removedBefore ?? null)))
      throw new TeamOwnerError('hold');
    let previous = record.input.expectedRevision, previousVersion = record.beforeVersion;
    for (const edge of [record.publication, record.compensation]) {
      if (!edge) continue;
      if (edge.beforeRevision !== previous || edge.beforeVersion !== previousVersion ||
          edge.afterVersion !== edge.beforeVersion + 1 || edge.position !== delta.position ||
          ![edge.before?.memberId, edge.after?.memberId].includes(delta.targetId)) throw new TeamOwnerError('hold');
      previous = edge.afterRevision; previousVersion = edge.afterVersion;
    }
    if (row.revision !== previous) throw new TeamOwnerError('hold');
  }
  if (unresolved > 1) throw new TeamOwnerError('hold');
}

/** Finite admin use case on Team's existing state and authority fence; no independent persistence. */
export class TeamLiveRosterMembership {
  constructor(private readonly options: {
    binding: TeamBinding; store: TeamStore; state(): OwnerState;
    authorize(principalId: string, permission: 'read' | 'admin'): TeamGrant;
    validate(state: OwnerState): void;
    members(state: OwnerState, input: ReplaceTeamRoster): TeamMember[];
    assertNoPending(commandId?: string): void;
    project(state: OwnerState, previous: JsonValue): JsonValue;
    recover(state: OwnerState): void; invalidate(): void;
  }) {}

  preview(principalId: string, raw: ReplaceTeamRoster): LiveRosterPreview | undefined {
    const input = replaceRosterSchema.parse(raw);
    return this.options.store.fenced(() => {
      const grant = this.options.authorize(principalId, 'admin'); this.options.authorize(principalId, 'read');
      const state = this.options.state(); this.options.validate(state);
      if (state.rosterCommands?.some(row => row.commandId === input.commandId)) return undefined;
      if (revision(state) !== input.expectedRevision) throw new TeamOwnerError('conflict');
      const delta = deriveLiveRosterDelta(state, input, this.options.members(state, input));
      return delta ? structuredClone({ input, delta, authorityRevision: grant.revision ?? 1 }) : undefined;
    });
  }

  retained(principalId: string): LiveRosterReceipt[] {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read'); this.options.authorize(principalId, 'admin');
      const state = this.options.state(); this.options.validate(state);
      return structuredClone((state.rosterCommands ?? []).filter((row): row is LiveRosterReceipt => !!row.liveMembership));
    });
  }

  lookup(principalId: string, raw: ReplaceTeamRoster, requestDigest: string): LiveRosterResponse | undefined {
    const input = replaceRosterSchema.parse(raw);
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const state = this.options.state(); this.options.validate(state);
      const row = this.find(state, principalId, input);
      if (!row) return undefined;
      if (!row.liveMembership) return { ok: true, value: { commandId: row.commandId, revision: row.revision } };
      if (row.liveMembership.requestDigest !== requestDigest) throw new TeamOwnerError('conflict');
      return this.result(row as LiveRosterReceipt);
    });
  }

  /** Duplicate admission returns metadata only; no loaded record creates the original live continuation. */
  begin(principalId: string, raw: ReplaceTeamRoster, requestDigest: string, source: LiveRosterSource):
    { fresh: boolean; record: LiveRosterReceipt } {
    const input = replaceRosterSchema.parse(raw);
    source.assertCurrent();
    return this.options.store.fenced(() => {
      source.assertCurrent();
      const grant = this.options.authorize(principalId, 'admin'); this.options.authorize(principalId, 'read');
      const state = this.options.state(); this.options.validate(state);
      const prior = this.find(state, principalId, input);
      if (prior) {
        if (!prior.liveMembership || prior.liveMembership.requestDigest !== requestDigest) throw new TeamOwnerError('conflict');
        return { fresh: false, record: structuredClone(prior as LiveRosterReceipt) };
      }
      if (revision(state) !== input.expectedRevision) throw new TeamOwnerError('conflict');
      if (this.options.store.read(`commands/${digest(input.commandId)}.json`) ||
          state.runtimeCaptures?.some(row => row.commandId === input.commandId)) throw new TeamOwnerError('conflict');
      if ((state.rosterCommands?.length ?? 0) >= 1024 || state.rosterCommands?.some(row =>
          row.liveMembership && !settled(row.liveMembership))) throw new TeamOwnerError('hold');
      this.options.assertNoPending();
      const delta = deriveLiveRosterDelta(state, input, this.options.members(state, input));
      if (!delta) throw new TeamOwnerError('invalid');
      if (delta.kind !== 'remove') assertTeamExecutionAllowed(state, this.options.store);
      const remaining = source.cutoff - Date.now();
      if (!Number.isSafeInteger(source.cutoff) || remaining <= 0 || remaining > 100_000)
        throw new TeamOwnerError('hold');
      const record: LiveRosterReceipt = {
        commandId: input.commandId, principalId, fingerprint: this.fingerprint(principalId, input), revision: revision(state),
        liveMembership: { schemaVersion: 1, phase: 'pending', input: structuredClone(input), requestDigest,
          authorityRevision: grant.revision ?? 1, launchId: source.launchId, sourceCaptureDigest: source.sourceCaptureDigest,
          hostIncarnation: source.hostIncarnation, cutoff: source.cutoff, beforeVersion: state.rosterVersion ?? 0,
          delta, peerDigest: peers(state, delta), savedSettingsDigest: digest(state.savedSettings ?? null) },
      };
      const next = structuredClone(state); next.rosterCommands = [...(next.rosterCommands ?? []), record];
      this.publish(next, false);
      return { fresh: true, record: structuredClone(record) };
    });
  }

  original(source: LiveRosterOriginal): LiveRosterReceipt {
    return this.withOriginal(source, row => structuredClone(row));
  }
  withOriginal<T>(source: LiveRosterOriginal, callback: (row: LiveRosterReceipt) => T): T {
    source.assertCurrent();
    return this.options.store.fenced(() => {
      source.assertCurrent();
      const grant = this.options.authorize(source.principalId, 'admin'); this.options.authorize(source.principalId, 'read');
      const state = this.options.state(); this.options.validate(state);
      const row = state.rosterCommands?.find(item => item.commandId === source.commandId) as LiveRosterReceipt | undefined;
      const record = row?.liveMembership;
      if (!row || !record || row.principalId !== source.principalId || row.fingerprint !== source.fingerprint ||
          record.requestDigest !== source.requestDigest || record.authorityRevision !== source.authorityRevision ||
          (grant.revision ?? 1) !== source.authorityRevision || record.launchId !== source.launchId ||
          record.sourceCaptureDigest !== source.sourceCaptureDigest || record.hostIncarnation !== source.hostIncarnation ||
          record.cutoff !== source.cutoff) throw new TeamOwnerError('conflict');
      if (revision(state) !== row.revision || peers(state, record.delta) !== record.peerDigest ||
          digest(state.savedSettings ?? null) !== record.savedSettingsDigest) throw new TeamOwnerError('conflict');
      const expected = record.compensation?.after ?? (record.compensation ? null :
        record.publication?.after ?? (record.publication ? null : record.delta.before));
      if (digest(state.members.find(member => member.memberId === record.delta.targetId) ?? null) !== digest(expected))
        throw new TeamOwnerError('conflict');
      return callback(row);
    });
  }

  captured(source: LiveRosterOriginal, value: LiveRosterCaptureView): void {
    const capture = liveRosterCaptureViewSchema.parse(value);
    this.update(source, (record) => {
      if (record.phase !== 'pending' || record.delta.kind === 'remove' || Date.now() >= record.cutoff)
        throw new TeamOwnerError('hold');
      record.capture = capture; record.phase = 'captured';
    });
  }
  preparing(source: LiveRosterOriginal, captureDigest: string): void {
    this.update(source, record => {
      if (record.phase !== 'captured' || record.capture?.captureDigest !== captureDigest || Date.now() >= record.cutoff)
        throw new TeamOwnerError('hold');
      record.phase = 'preparing';
    });
  }

  /** Runtime/endpoint/provider proof is obtained outside Team's lock, immediately before this call. */
  publishTarget(source: LiveRosterOriginal, selection?: LiveRosterSelection): LiveRosterReceipt {
    return this.withOriginal(source, original => {
      const state = this.options.state(), record = original.liveMembership;
      if (record.publication || (record.delta.kind === 'remove' ? record.phase !== 'pending' : record.phase !== 'preparing'))
        throw new TeamOwnerError('hold');
      if (record.delta.kind !== 'remove') {
        assertTeamExecutionAllowed(state, this.options.store);
        if (Date.now() >= record.cutoff || !record.capture || !selection ||
            selection.configurationDigest !== record.capture.target.configurationDigest ||
            state.grants.some(grant => grant.principalId === selection.principalId)) throw new TeamOwnerError('hold');
      } else if (selection) throw new TeamOwnerError('invalid');
      this.options.assertNoPending(source.commandId);
      const next = structuredClone(state), row = next.rosterCommands!.find(item => item.commandId === source.commandId) as LiveRosterReceipt;
      const delta = row.liveMembership.delta;
      const target = delta.after ? { ...structuredClone(delta.after), delivery: structuredClone(selection!.delivery) } : null;
      const removedBefore = next.removedMembers?.find(item => item.memberId === delta.targetId);
      next.members = next.members.filter(member => member.memberId !== delta.targetId);
      if (target) next.members.splice(delta.position, 0, target);
      next.removedMembers = (next.removedMembers ?? []).filter(member => member.memberId !== delta.targetId);
      let removedAfter: (TeamMember & { removedAt: string }) | undefined;
      if (!target) {
        removedAfter = { ...structuredClone(delta.before!), removedAt: new Date().toISOString() };
        next.removedMembers.push(removedAfter);
      }
      for (const grant of next.grants) if (grant.memberName === targetName(delta) && !grant.revoked) {
        grant.revoked = true; grant.revision = (grant.revision ?? 1) + 1;
      }
      if (selection) {
        delete next.runtimeNeverLaunched;
        next.grants.push({ principalId: selection.principalId, memberName: target!.name,
          permissions: ['read', 'task.write', 'message.write', 'process.write'], revision: 1 });
        row.liveMembership.selection = structuredClone(selection);
      }
      next.rosterVersion = (state.rosterVersion ?? 0) + 1;
      row.liveMembership.publication = { beforeRevision: original.revision, afterRevision: revision(next),
        beforeVersion: state.rosterVersion ?? 0, afterVersion: next.rosterVersion,
        before: structuredClone(delta.before), after: structuredClone(target), position: delta.position,
        ...(removedBefore ? { removedBefore: structuredClone(removedBefore) } : {}),
        ...(removedAfter ? { removedAfter: structuredClone(removedAfter) } : {}) };
      row.liveMembership.phase = 'published'; row.revision = revision(next);
      this.publish(next, true); return structuredClone(row);
    });
  }

  complete(source: LiveRosterOriginal): LiveRosterResponse {
    return this.update(source, record => {
      if (record.phase !== 'published') throw new TeamOwnerError('hold');
      record.phase = 'completed';
    });
  }
  hold(source: LiveRosterOriginal): LiveRosterResponse {
    return this.update(source, record => { if (!settled(record)) record.phase = 'held'; });
  }
  compensating(source: LiveRosterOriginal): void {
    this.update(source, record => {
      if (record.phase !== 'published' || record.delta.kind === 'remove') throw new TeamOwnerError('hold');
      record.phase = 'compensating';
    });
  }
  /** Called only after original target/probe release was proved; never restores a whole state snapshot. */
  rejectReleased(source: LiveRosterOriginal, code: TeamOwnerErrorCode): LiveRosterResponse {
    return this.withOriginal(source, original => {
      const state = this.options.state(), next = structuredClone(state),
        row = next.rosterCommands!.find(item => item.commandId === source.commandId) as LiveRosterReceipt,
        record = row.liveMembership, delta = record.delta;
      if (settled(record) || record.delta.kind === 'remove' && record.publication) throw new TeamOwnerError('hold');
      if (record.publication) {
        if (record.phase !== 'compensating') throw new TeamOwnerError('hold');
        next.members = next.members.filter(member => member.memberId !== delta.targetId);
        if (delta.before) next.members.splice(delta.position, 0, structuredClone(delta.before));
        next.removedMembers = (next.removedMembers ?? []).filter(member => member.memberId !== delta.targetId);
        if (delta.removedBefore) next.removedMembers.splice(delta.removedPosition!, 0, structuredClone(delta.removedBefore));
        for (const grant of next.grants) if (grant.principalId === record.selection?.principalId && !grant.revoked) {
          grant.revoked = true; grant.revision = (grant.revision ?? 1) + 1;
        }
        next.rosterVersion = (next.rosterVersion ?? 0) + 1;
        record.compensation = { beforeRevision: original.revision, afterRevision: revision(next),
          beforeVersion: state.rosterVersion ?? 0, afterVersion: next.rosterVersion,
          before: structuredClone(record.publication.after), after: structuredClone(delta.before), position: delta.position,
          ...(delta.removedBefore ? { removedAfter: structuredClone(delta.removedBefore) } : {}) };
      }
      record.phase = 'rejected'; record.rejection = code; row.revision = revision(next);
      this.publish(next, !!record.compensation); return this.result(row);
    });
  }

  private update(source: LiveRosterOriginal, mutate: (record: LiveRosterMembershipRecord) => void): LiveRosterResponse {
    return this.withOriginal(source, () => {
      const next = structuredClone(this.options.state()),
        row = next.rosterCommands!.find(item => item.commandId === source.commandId) as LiveRosterReceipt;
      mutate(row.liveMembership); this.publish(next, false); return this.result(row);
    });
  }
  private find(state: OwnerState, principalId: string, input: ReplaceTeamRoster): StoredRosterReceipt | undefined {
    const row = state.rosterCommands?.find(item => item.commandId === input.commandId);
    if (row && (row.principalId !== principalId || row.fingerprint !== this.fingerprint(principalId, input)))
      throw new TeamOwnerError('conflict');
    return row;
  }
  private fingerprint(principalId: string, input: ReplaceTeamRoster): string {
    return digest({ binding: this.options.binding, principalId, operation: 'roster.replace', input });
  }
  private result(row: LiveRosterReceipt): LiveRosterResponse {
    const record = row.liveMembership;
    return parseLiveRosterResponse(record.phase === 'completed'
      ? { ok: true, value: { commandId: row.commandId, revision: row.revision } }
      : record.phase === 'rejected'
        ? { ok: false, code: record.rejection!, outcome: 'rejected' }
        : { ok: true, liveRosterPending: { commandId: row.commandId, requestDigest: record.requestDigest,
          phase: record.phase, captureDigest: record.capture?.captureDigest ?? null } });
  }
  private publish(state: OwnerState, product: boolean): void {
    if (product) {
      const before = this.options.store.read<JsonValue>('../config.json');
      if (!before || typeof before !== 'object' || Array.isArray(before)) throw new TeamOwnerError('hold');
      state.rosterProjection = { before, after: this.options.project(state, before) };
    }
    this.options.validate(state);
    if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) throw new TeamOwnerError('hold');
    this.options.store.write('state.json', state); this.options.invalidate(); this.options.recover(state);
  }
}
