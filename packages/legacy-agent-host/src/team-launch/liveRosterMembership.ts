import { z } from 'zod';
import { runtimeDigest as digest, normalizeBinding } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import { validateLaunchPreparation } from './launchPreparation.js';
import { launchWorktreePlanSchema, launchWorktreeReceiptSchema } from './worktreeSchema.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { ExpectedLaunchMember, LaunchAttempt, TeamLaunchDefinition, TeamLaunchRecord } from './contracts.js';
import type { LaunchWorktreePlan, LaunchWorktreeReceipt } from './worktreeContracts.js';

const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const binding = z.object({ backendId: id, teamId: id, runId: id, memberId: id, generation: id }).strict();
export const liveExpectedMemberSchema = z.object({
  memberId: id, binding: binding.nullable(), configurationDigest: hash.nullable(),
  contextDigest: hash.nullable(), configRevision: id.nullable(), skipped: z.boolean(),
  timeoutMs: z.number().int().min(1).max(300000), runtimeGeneration: z.number().int().nonnegative().optional(),
  baseConfigurationDigest: hash.optional(),
  restore: z.object({ commandId: id, reference: z.string().regex(/^cp1-[a-f0-9]{64}$/u),
    sourceBinding: binding }).strict().optional(),
}).strict();
const intentSchema = z.object({
  commandId: id, requestDigest: hash, originalFingerprint: hash, authorityRevision: z.number().int().positive(),
  principalId: id, launchId: id, sourceCaptureDigest: hash, expectedRevision: hash,
  hostIncarnation: id, cutoff: z.number().int().positive(), kind: z.enum(['add', 'remove', 'restore']),
  memberId: id, source: liveExpectedMemberSchema.nullable(),
  previous: liveExpectedMemberSchema.nullable(),
}).strict();
export interface LiveLaunchIntent extends Omit<z.infer<typeof intentSchema>, 'source' | 'previous'> {
  source: ExpectedLaunchMember | null;
  previous: ExpectedLaunchMember | null;
}
const rowSchema = z.object({
  intent: intentSchema, fingerprint: hash,
  phase: z.enum(['pending', 'captured', 'selected', 'removed', 'compensated', 'held', 'rejected']),
  worktree: launchWorktreePlanSchema.optional(),
  seed: z.unknown().optional(), seedDigest: hash.optional(),
  capture: z.unknown().optional(), captureDigest: hash.optional(), selected: liveExpectedMemberSchema.optional(),
  rosterRevision: hash.optional(),
}).strict();
export interface LiveLaunchMembership extends Omit<z.infer<typeof rowSchema>, 'intent' | 'capture' | 'selected'> {
  intent: LiveLaunchIntent;
  capture?: JsonValue;
  selected?: ExpectedLaunchMember;
}
export type LiveLaunchRecord = TeamLaunchRecord & { liveMembership?: LiveLaunchMembership[] };
export interface LiveLaunchJournal {
  authorized<T>(action: () => T): T;
  read(): LiveLaunchRecord;
  write(record: LiveLaunchRecord): void;
  initial(member: ExpectedLaunchMember, attemptId: string): LaunchAttempt;
}
function fail(reason: string): never { throw new TeamLaunchError('hold', reason); }
const same = (a: unknown, b: unknown) => digest(a ?? null) === digest(b ?? null);
const selected = (row: LiveLaunchMembership) =>
  row.selected !== undefined && ['selected', 'removed', 'compensated'].includes(row.phase);
const transitionCount = (record: LiveLaunchRecord) =>
  (record.liveMembership?.length ?? 0) + (record.memberActions?.length ?? 0) + (record.restorations?.length ?? 0);
const recalculate = (record: LiveLaunchRecord) => {
  record.definition.rosterRevision = digest({
    scope: record.definition.rosterScope ?? record.definition.launchId, members: record.definition.members,
  });
  record.fingerprint = digest(record.definition);
};

/** A removed product member retains its exact old binding/attempts as history, never as Skip. */
export function liveRosterMemberRemoved(record: LiveLaunchRecord, memberId: string): boolean {
  const row = (record.liveMembership ?? []).filter(item => item.intent.memberId === memberId &&
    ['selected', 'removed', 'compensated'].includes(item.phase)).at(-1);
  return row?.phase === 'removed' || row?.phase === 'compensated';
}
export function liveRosterMemberBlocked(record: LiveLaunchRecord, memberId: string): boolean {
  return liveRosterMemberRemoved(record, memberId) || (record.liveMembership ?? []).some(row =>
    row.intent.memberId === memberId && ['pending', 'captured', 'held'].includes(row.phase));
}
export function liveRosterHistoryFull(record: LiveLaunchRecord): boolean {
  return record.liveMembership !== undefined && transitionCount(record) >= 64;
}
export function liveRosterStartAllowed(record: LiveLaunchRecord, memberId: string,
  commandId: string | undefined, hasAuthority: boolean): boolean {
  if (liveRosterMemberBlocked(record, memberId)) return false;
  const member = record.members.find(row => row.memberId === memberId);
  const row = record.liveMembership?.find(item => item.phase === 'selected' &&
    item.intent.memberId === memberId && member?.currentAttemptId === `live-${digest(item.intent.commandId)}`);
  const attempt = member?.attempts.at(-1);
  return !row || attempt?.claimed === true || hasAuthority && row.intent.commandId === commandId;
}

/** Only validated membership edges may cross a native recipe/generation segment. */
export function liveRosterSelectionEdges(record: LiveLaunchRecord) {
  return (record.liveMembership ?? []).filter(row => selected(row) && row.intent.source !== null)
    .map(row => ({ source: row.intent.source!, member: row.selected!, commandId: row.intent.commandId }));
}

/** Follow original Restart/Resume edges, stopping before the next fresh membership source. */
export function liveRosterSegment(record: LiveLaunchRecord, initial: RuntimeBinding):
  { member: ExpectedLaunchMember; current: boolean } | undefined {
  if (!record.liveMembership?.length) return undefined;
  const edges = [
    ...(record.memberActions ?? []).filter(row => row.phase === 'selected' && row.input.action === 'restart')
      .map(row => ({ source: row.source.binding, member: row.selected })),
    ...(record.restorations ?? []).map(row => ({ source: row.member.restore?.sourceBinding, member: row.member })),
  ];
  let value = normalizeBinding(initial);
  const visited = new Set<string>();
  for (;;) {
    const key = digest(value);
    if (visited.has(key)) fail('live-roster-selection-cycle');
    visited.add(key);
    const matches = edges.filter(row => same(row.source, value));
    if (!matches.length) break;
    if (matches.length !== 1 || !matches[0]!.member.binding) fail('live-roster-selection-chain');
    value = normalizeBinding(matches[0]!.member.binding!);
  }
  const latest = record.definition.members.find(row => row.memberId === value.memberId);
  if (latest && same(latest.binding, value))
    return { member: latest, current: !liveRosterMemberRemoved(record, value.memberId) };
  const boundaries = liveRosterSelectionEdges(record).filter(row => same(row.source.binding, value));
  if (boundaries.length !== 1) fail('live-roster-source-segment');
  return { member: boundaries[0]!.source, current: false };
}

/** Structural history, including an interrupted capture, does not grant continuation or physical release. */
export function validateLiveRosterLaunch(record: LiveLaunchRecord): void {
  if (record.liveMembership === undefined) return;
  if (!Array.isArray(record.liveMembership) || !record.liveMembership.length || transitionCount(record) > 64 ||
      Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024) fail('live-roster-record-budget');
  const commands = new Set([
    ...(record.memberActions ?? []).map(row => row.input.commandId),
    ...(record.restorations ?? []).map(row => row.commandId),
    ...(record.nativeAdditions ?? []).map(row => row.commandId),
  ]);
  const current = new Map<string, ExpectedLaunchMember | null>();
  const removed = new Map<string, boolean>();
  let unsettled = 0;
  for (const raw of record.liveMembership) {
    rowSchema.parse(raw);
    const row = raw, intent = row.intent;
    if (commands.has(intent.commandId) || intent.launchId !== record.definition.launchId ||
        row.fingerprint !== digest(intent) || intent.source?.memberId !== undefined &&
        intent.source.memberId !== intent.memberId || intent.previous?.memberId !== undefined &&
        intent.previous.memberId !== intent.memberId) fail('live-roster-record');
    commands.add(intent.commandId);
    if (intent.source?.binding && intent.source.binding.runId !== intent.launchId)
      fail('live-roster-source-run');
    if (intent.source && !intent.previous) fail('live-roster-previous-selection');
    if (intent.previous?.runtimeGeneration !== undefined && intent.source?.runtimeGeneration !== undefined &&
        intent.previous.runtimeGeneration < intent.source.runtimeGeneration) fail('live-roster-previous-generation');
    if (current.has(intent.memberId)) {
      const prior = current.get(intent.memberId);
      // Intervening original Restart/Resume can advance a segment without changing its recipe.
      if (!same(prior, intent.source)) {
        if (!prior?.binding || !intent.source?.binding) fail('live-roster-history-source');
        const segment = segmentSuccessor(record, prior, intent.source);
        if (!segment) fail('live-roster-history-source');
      }
      if (intent.kind === 'restore' && removed.get(intent.memberId) !== true)
        fail('live-roster-restore-source');
      if (intent.kind === 'remove' && removed.get(intent.memberId) === true)
        fail('live-roster-remove-source');
    }
    if (intent.kind === 'remove' && !intent.previous) fail('live-roster-remove-source');
    if ((row.seed === undefined) !== (row.seedDigest === undefined) || row.seed !== undefined &&
        (Buffer.byteLength(JSON.stringify(row.seed)) > 512 * 1024 || digest(row.seed) !== row.seedDigest))
      fail('live-roster-seed');
    const hasCapture = row.capture !== undefined || row.captureDigest !== undefined || row.selected !== undefined;
    if (hasCapture) {
      if (intent.kind === 'remove' || row.capture === undefined || !row.captureDigest || !row.selected ||
          Buffer.byteLength(JSON.stringify(row.capture)) > 512 * 1024 ||
          digest(row.capture) !== row.captureDigest) fail('live-roster-capture');
      const member = row.selected;
      if (!member.binding || member.memberId !== intent.memberId || member.binding.memberId !== intent.memberId ||
          member.binding.runId !== intent.launchId || member.skipped || member.restore ||
          !member.baseConfigurationDigest || member.configurationDigest !== member.baseConfigurationDigest ||
          !member.contextDigest || !member.configRevision || !Number.isSafeInteger(member.runtimeGeneration) ||
          member.runtimeGeneration! <= (intent.previous?.runtimeGeneration ?? -1) ||
          member.binding.generation !== `live-${digest({ commandId: intent.commandId,
            requestDigest: intent.requestDigest, previous: intent.previous?.binding ?? null })}`)
        fail('live-roster-selection');
      if (intent.previous?.binding && ['backendId', 'teamId', 'memberId'].some(key =>
          intent.previous!.binding![key as 'memberId'] !== member.binding![key as 'memberId']))
        fail('live-roster-selection-scope');
    }
    if (['captured', 'selected', 'compensated'].includes(row.phase) && !hasCapture)
      fail('live-roster-capture-missing');
    if (row.phase === 'removed' && intent.kind !== 'remove' ||
        row.phase === 'selected' && intent.kind === 'remove' ||
        row.phase === 'compensated' && intent.kind === 'remove') fail('live-roster-phase');
    if (['selected', 'removed', 'compensated'].includes(row.phase) !== (row.rosterRevision !== undefined))
      fail('live-roster-publication');
    if (['pending', 'captured', 'held'].includes(row.phase)) unsettled++;
    if (unsettled > 1) fail('live-roster-unresolved');
    if (selected(raw)) {
      current.set(intent.memberId, row.selected!);
      removed.set(intent.memberId, row.phase === 'compensated');
    } else if (row.phase === 'removed') {
      current.set(intent.memberId, intent.source);
      removed.set(intent.memberId, true);
    } else if (!current.has(intent.memberId)) current.set(intent.memberId, intent.source);
  }
  for (const [memberId, original] of current) {
    if (!original) continue; // A retained pre-publication add has no expected Runtime selection.
    const expected = record.definition.members.find(row => row.memberId === memberId);
    if (!expected || !same(expected, original) && !segmentSuccessor(record, original, expected))
      fail('live-roster-current-selection');
  }
}

function segmentSuccessor(record: LiveLaunchRecord, from: ExpectedLaunchMember, to: ExpectedLaunchMember): boolean {
  const edges = [
    ...(record.memberActions ?? []).filter(row => row.phase === 'selected')
      .map(row => ({ source: row.source, selected: row.selected })),
    ...(record.restorations ?? []).map(row => ({ source: { binding: row.member.restore?.sourceBinding }, selected: row.member })),
  ];
  let value = from;
  const used = new Set<object>();
  for (let count = 0; count <= edges.length; count++) {
    if (same(value, to)) return true;
    const skips = edges.filter(row => !used.has(row) && same(row.source, value) &&
      row.selected.skipped && same(row.selected.binding, value.binding));
    const next = skips.length ? skips : edges.filter(row => !used.has(row) &&
      same(row.source.binding, value.binding) && !same(row.selected.binding, value.binding));
    if (next.length !== 1) return false;
    const edge = next[0]!;
    if (edge.selected.baseConfigurationDigest !== value.baseConfigurationDigest ||
        edge.selected.contextDigest !== value.contextDigest || edge.selected.configRevision !== value.configRevision ||
        edge.selected.timeoutMs !== value.timeoutMs) return false;
    used.add(edge); value = edge.selected;
  }
  return false;
}

/** Preserve the exact old preparation atom against its own segment, rather than a later fresh recipe. */
export function validateLiveLaunchPreparation(record: LiveLaunchRecord): void {
  if (!record.liveMembership?.length || !record.preparation) return validateLaunchPreparation(record);
  validateLiveRosterLaunch(record);
  const members = record.definition.members.map(member => {
    const prepared = record.preparation!.members.find(row => row.memberId === member.memberId);
    if (!prepared) return member;
    const first = record.liveMembership!.find(row => row.intent.memberId === member.memberId && row.intent.source);
    return first?.intent.source ?? member;
  });
  validateLaunchPreparation({ ...record, definition: { ...record.definition, members } });
}
export function liveRosterValidationRecord(record: LiveLaunchRecord): TeamLaunchRecord {
  if (!record.liveMembership?.length) return record;
  validateLiveRosterLaunch(record);
  validateLiveLaunchPreparation(record);
  const { preparation: _preparation, ...ordinary } = record;
  return ordinary;
}

/** Exact definition predecessor for the existing cold native-addition/base validator. */
export function liveRosterOriginalDefinition(record: LiveLaunchRecord): TeamLaunchDefinition {
  validateLiveRosterLaunch(record);
  const definition = structuredClone(record.definition);
  for (const row of [...(record.liveMembership ?? [])].reverse()) {
    if (!selected(row)) continue;
    const index = definition.members.findIndex(member => member.memberId === row.intent.memberId);
    if (index < 0) fail('live-roster-original-definition');
    if (row.intent.source) definition.members[index] = structuredClone(row.intent.source);
    else definition.members.splice(index, 1);
  }
  definition.rosterRevision = digest({ scope: definition.rosterScope ?? definition.launchId, members: definition.members });
  return definition;
}

/** Same launch file and caller's original Team fence. This helper never observes or opens Runtime. */
export function createLiveRosterLaunch(journal: LiveLaunchJournal) {
  const read = (commandId: string) => {
    const record = journal.read(); validateLiveRosterLaunch(record);
    const row = record.liveMembership?.find(value => value.intent.commandId === commandId);
    if (!row) fail('live-roster-launch-missing');
    return { record, row };
  };
  const write = (record: LiveLaunchRecord) => {
    validateLiveRosterLaunch(record);
    if (Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024) fail('live-roster-record-budget');
    journal.write(record);
  };
  return {
    attemptFor: (value: RuntimeBinding) => journal.authorized(() => {
      const record = journal.read(); validateLiveRosterLaunch(record);
      const member = record.members.find(row => row.memberId === value.memberId);
      const action = record.memberActions?.filter(row => row.phase === 'selected' && same(row.selected.binding, value)).at(-1);
      const restored = record.restorations?.find(row => same(row.member.binding, value));
      const live = record.liveMembership?.find(row => selected(row) && same(row.selected?.binding, value));
      const native = record.nativeAdditions?.find(row => same(row.member.binding, value));
      const attemptId = action ? `action-${digest(action.input.commandId)}`
        : restored ? `restore-${digest(restored.commandId)}`
        : live ? `live-${digest(live.intent.commandId)}`
        : native ? `native-add-${digest({ commandId: native.commandId, memberId: value.memberId })}`
        : `initial-${digest({ launchId: record.definition.launchId, memberId: value.memberId })}`;
      const attempt = member?.attempts.find(row => row.attemptId === attemptId);
      if (!attempt) fail('live-roster-original-attempt');
      return structuredClone(attempt);
    }),
    inspect: (memberId: string) => journal.authorized(() => {
      const record = journal.read(); validateLiveRosterLaunch(record);
      return structuredClone({
        member: record.definition.members.find(row => row.memberId === memberId) ?? null,
        attempts: record.members.find(row => row.memberId === memberId)?.attempts ?? [],
        history: (record.liveMembership ?? []).filter(row => row.intent.memberId === memberId),
      });
    }),
    read: (commandId: string) => journal.authorized(() => structuredClone(read(commandId).row)),
    begin(raw: LiveLaunchIntent): boolean {
      intentSchema.parse(raw);
      const intent = structuredClone(raw);
      return journal.authorized(() => {
        const record = journal.read(); validateLiveRosterLaunch(record);
        const previous = record.liveMembership?.find(row => row.intent.commandId === intent.commandId);
        if (previous) {
          if (previous.fingerprint !== digest(intent)) fail('live-roster-launch-conflict');
          return false;
        }
        if (intent.launchId !== record.definition.launchId || transitionCount(record) >= 64 ||
            intent.cutoff <= Date.now() || intent.cutoff - Date.now() > 100000 ||
            (record.liveMembership ?? []).some(row => ['pending', 'captured', 'held'].includes(row.phase)) ||
            record.memberActions?.some(row => !['selected', 'refused'].includes(row.phase)) ||
            !same(record.definition.members.find(member => member.memberId === intent.memberId), intent.source))
          fail('live-roster-launch-admission');
        if (intent.kind !== 'remove' && !intent.source && record.definition.members.length >= 256)
          fail('live-roster-member-budget');
        record.liveMembership = [...(record.liveMembership ?? []), { intent: structuredClone(intent),
          fingerprint: digest(intent), phase: 'pending' }];
        write(record); return true;
      });
    },
    seed(commandId: string, value: JsonValue): void {
      journal.authorized(() => {
        const { record, row } = read(commandId);
        if (row.phase !== 'pending' || row.intent.kind === 'remove' || row.seed !== undefined || Date.now() >= row.intent.cutoff)
          fail('live-roster-seed-admission');
        row.seed = structuredClone(value); row.seedDigest = digest(value); write(record);
      });
    },
    plan(commandId: string, plan: LaunchWorktreePlan): void {
      journal.authorized(() => {
        const { record, row } = read(commandId);
        launchWorktreePlanSchema.parse(plan);
        const next = structuredClone(plan);
        if (row.phase !== 'pending' || row.intent.kind === 'remove' || !row.seedDigest || row.worktree || Date.now() >= row.intent.cutoff)
          fail('live-roster-worktree-admission');
        row.worktree = next; write(record);
      });
    },
    readWorktree(commandId: string): LaunchWorktreeReceipt | undefined {
      return journal.authorized(() => {
        const { record, row } = read(commandId);
        if (!row.worktree) fail('live-roster-worktree-missing');
        const receipt = record.worktrees?.find(value => value.planDigest === digest(row.worktree));
        return receipt ? launchWorktreeReceiptSchema.parse(receipt) : undefined;
      });
    },
    writeWorktree(commandId: string, next: LaunchWorktreeReceipt, expected?: LaunchWorktreeReceipt): void {
      journal.authorized(() => {
        const { record, row } = read(commandId), value = launchWorktreeReceiptSchema.parse(next);
        if (row.phase !== 'pending' || !row.worktree || value.planDigest !== digest(row.worktree) ||
            Date.now() >= row.intent.cutoff) fail('live-roster-worktree-current');
        const rows = record.worktrees ?? [], index = rows.findIndex(item => item.planDigest === value.planDigest);
        if (!same(index < 0 ? undefined : rows[index], expected) || index < 0 && rows.length >= 256)
          fail('live-roster-worktree-receipt');
        if (index < 0) rows.push(value); else rows[index] = value;
        record.worktrees = rows; write(record);
      });
    },
    capture(commandId: string, capture: JsonValue, member: ExpectedLaunchMember): void {
      journal.authorized(() => {
        const { record, row } = read(commandId);
        if (row.phase !== 'pending' || row.intent.kind === 'remove' || !row.seedDigest || Date.now() >= row.intent.cutoff)
          fail('live-roster-capture-admission');
        if (row.worktree) {
          const receipt = record.worktrees?.find(value => value.planDigest === digest(row.worktree));
          if (receipt?.state !== 'completed' || !receipt.binding) fail('live-roster-worktree-unsettled');
        }
        row.capture = structuredClone(capture); row.captureDigest = digest(capture);
        liveExpectedMemberSchema.parse(member);
        row.selected = structuredClone(member); row.phase = 'captured'; write(record);
      });
    },
    publish(commandId: string, rosterRevision: string): ExpectedLaunchMember | null {
      return journal.authorized(() => {
        const { record, row } = read(commandId); hash.parse(rosterRevision);
        if (!same(record.definition.members.find(member => member.memberId === row.intent.memberId), row.intent.source))
          fail('live-roster-launch-source');
        if (row.intent.kind === 'remove') {
          if (row.phase !== 'pending') fail('live-roster-remove-admission');
          row.phase = 'removed'; row.rosterRevision = rosterRevision; write(record); return null;
        }
        if (row.phase !== 'captured' || !row.selected || Date.now() >= row.intent.cutoff)
          fail('live-roster-selection-admission');
        const member = structuredClone(row.selected), index = record.definition.members.findIndex(value => value.memberId === member.memberId);
        const attemptId = `live-${digest(commandId)}`;
        if (index < 0) {
          record.definition.members.push(member);
          record.members.push({ memberId: member.memberId, currentAttemptId: attemptId,
            attempts: [journal.initial(member, attemptId)] });
        } else {
          const history = record.members.find(value => value.memberId === member.memberId);
          if (!history || history.attempts.length >= 65) fail('live-roster-attempt-budget');
          record.definition.members[index] = member;
          history.currentAttemptId = attemptId; history.attempts.push(journal.initial(member, attemptId));
        }
        row.phase = 'selected'; row.rosterRevision = rosterRevision; recalculate(record); write(record);
        return structuredClone(member);
      });
    },
    rejectReleased(commandId: string, rosterRevision?: string): void {
      journal.authorized(() => {
        const { record, row } = read(commandId);
        if (row.phase === 'selected') {
          if (!rosterRevision) fail('live-roster-compensation-revision');
          hash.parse(rosterRevision); row.phase = 'compensated'; row.rosterRevision = rosterRevision;
        } else {
          if (!['pending', 'captured', 'held'].includes(row.phase) || rosterRevision !== undefined)
            fail('live-roster-rejection-phase');
          row.phase = 'rejected';
        }
        write(record);
      });
    },
    hold(commandId: string): void {
      journal.authorized(() => {
        const { record, row } = read(commandId);
        // A selected target retains its selection and physical debt; Team receipt carries the held outcome.
        if (row.phase === 'pending' || row.phase === 'captured') { row.phase = 'held'; write(record); }
      });
    },
  };
}
