import { z } from 'zod';
import { modelReadinessReferenceSchema } from '../management/commandRecords.js';
import { managementDigest } from '../management/identity.js';
import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';

import type { JsonValue } from '../contracts.js';
import type { ModelReadinessReference } from '../management/commandRecords.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { LaunchAttempt, TeamLaunchRecord } from './contracts.js';
import type { TeamLaunchDefinition } from './contracts.js';
import type { TeamStore } from '../team/ports.js';

const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().positive().safe();
const path = z.string().min(1).max(8192).refine(value => !/[\0\r\n]/u.test(value));
const binding = z.object({
  backendId: id, teamId: id, runId: id, memberId: id, generation: id,
}).strict();

export const localModelReadinessCaptureSchema = z.object({
  launchId: id, rosterRevision: id,
}).strict();
export type LocalModelReadinessCapture = z.infer<typeof localModelReadinessCaptureSchema>;

const captureTargetSchema = z.object({
  memberId: id, originalProbeCommandId: id, originalContext: hash, originalWorkspace: path,
  retired: z.literal(true).optional(),
}).strict();
const captureAdmissionSchema = z.object({
  commandId: id, preparationId: id, rosterCommandId: id, rosterRevision: id,
  teamBindingDigest: hash, actorDigest: hash, associationDigest: hash,
  sourceDigest: hash, admission: hash, hostIncarnation: id, cutoff: time,
  phase: z.enum(['capturing', 'captured', 'retired']),
  targets: z.array(captureTargetSchema).min(1).max(256),
}).strict().refine(value => new Set(value.targets.map(row => row.memberId)).size === value.targets.length);
export type LaunchReadinessCaptureAdmission = z.infer<typeof captureAdmissionSchema>;

/** Supplied only by the first live capture invocation, never reconstructed by restore/read. */
export type LiveReadinessCapture = Pick<LaunchReadinessCaptureAdmission,
  'commandId' | 'associationDigest' | 'cutoff'>;

const consumerSchema = z.object({
  consumerId: hash, memberId: id, actionId: id, actorDigest: hash, inputDigest: hash,
  binding, sourceAttemptId: id, baseConfigurationDigest: hash, configurationDigest: hash,
  configRevision: id, cutoff: time.optional(),
  groupCommandId: id.optional(),
  policyCommandId: id.optional(),
  /** First action admission records its cutoff before awaits, without qualifying allocation. */
  admissionOnly: z.literal(true).optional(),
  continuation: z.object({ reference: id, sourceBinding: binding }).strict().optional(),
  initialProfile: z.object({
    kind: z.literal('native-bootstrap'), captureDigest: hash, commandId: id, actionDigest: hash,
    predecessorConsumerId: hash.optional(),
  }).strict().optional(),
  disposition: z.enum(['pending', 'consumed', 'retired']),
}).strict().refine(value => value.memberId === value.binding.memberId &&
  (value.initialProfile ? value.cutoff === undefined && value.groupCommandId === undefined &&
    value.policyCommandId === undefined && value.admissionOnly === undefined && value.continuation === undefined
    : value.continuation === undefined ? value.cutoff !== undefined : value.groupCommandId === undefined));
export type LaunchReadinessConsumer = z.infer<typeof consumerSchema>;

export const launchReadinessSchema = z.object({
  schemaVersion: z.literal(1),
  capture: captureAdmissionSchema.optional(),
  groups: z.array(modelReadinessReferenceSchema),
  consumers: z.array(consumerSchema),
}).strict().superRefine((value, context) => {
  if (new Set(value.groups.map(row => row.commandId)).size !== value.groups.length ||
      new Set(value.consumers.map(row => row.consumerId)).size !== value.consumers.length ||
      new Set(value.consumers.filter(row => row.disposition !== 'retired')
        .map(row => row.memberId)).size !== value.consumers.filter(row => row.disposition !== 'retired').length)
    context.addIssue({ code: 'custom', message: 'Readiness references and active destinations must be unique' });
});
export type LaunchReadiness = z.infer<typeof launchReadinessSchema>;

export const localModelReadinessCaptureViewSchema = z.object({
  preparationId: id, captureCommandId: id, launchId: id, rosterRevision: id, captureDigest: hash,
  remainingMs: z.number().int().min(0).max(100000),
  targets: z.array(captureTargetSchema.omit({ originalContext: true, retired: true })).max(256),
}).strict();
export type LocalModelReadinessCaptureView = z.infer<typeof localModelReadinessCaptureViewSchema>;

export function actualCaptureReadinessCommandId(preparationId: string, captureCommandId: string, memberId: string): string {
  return `worktree-probe-${runtimeDigest({ preparationId, captureCommandId, memberId })}`;
}

/** Both full profile identities are checked separately; this compares only the native mechanism. */
export function modelReadinessMechanismDigest(profile: ProviderManagementProfile): string {
  const { profileId: _profileId, configRevision: _revision, ...mechanism } = profile;
  return runtimeDigest(mechanism);
}

function held(reason: string): never { throw new TeamLaunchError('hold', reason); }

/** An ordinary initial source can advance only through the existing exact native action or retry journal. */
function validateInitialReadiness(record: TeamLaunchRecord, consumer: LaunchReadinessConsumer,
  consumers: readonly LaunchReadinessConsumer[]): void {
  const source = consumer.initialProfile;
  if (!source) return;
  const { consumerId, disposition: _disposition, ...identity } = consumer;
  const member = record.members.find(row => row.memberId === consumer.memberId);
  const index = member?.attempts.findIndex(row => row.attemptId === consumer.sourceAttemptId) ?? -1;
  if (consumerId !== managementDigest(identity) || !member || index < 0)
    held('launch-readiness-initial-identity');
  if (!source.predecessorConsumerId) {
    if (consumer.actionId !== source.commandId || index !== 0 ||
        consumer.sourceAttemptId !== `initial-${runtimeDigest({ launchId: record.definition.launchId, memberId: consumer.memberId })}`)
      held('launch-readiness-initial-source');
    return;
  }
  const previous = consumers.find(row => row.consumerId === source.predecessorConsumerId);
  if (!previous?.initialProfile || consumers.indexOf(previous) >= consumers.indexOf(consumer) ||
      previous.memberId !== consumer.memberId || previous.disposition !== 'retired' ||
      previous.baseConfigurationDigest !== consumer.baseConfigurationDigest ||
      previous.initialProfile.captureDigest !== source.captureDigest ||
      previous.initialProfile.commandId !== source.commandId || previous.initialProfile.actionDigest !== source.actionDigest)
    held('launch-readiness-initial-predecessor');
  const action = record.memberActions?.find(row => row.input.commandId === consumer.actionId);
  if (action) {
    const { commandId: _commandId, ...input } = action.input;
    if (action.phase !== 'selected' || action.input.action !== 'restart' || !action.actor.inputAuthority ||
        action.sourceAttemptId !== previous.sourceAttemptId ||
        consumer.sourceAttemptId !== `action-${runtimeDigest(action.input.commandId)}` ||
        runtimeDigest(action.actor) !== consumer.actorDigest || managementDigest(input) !== consumer.inputDigest ||
        runtimeDigest(action.source.binding) !== runtimeDigest(previous.binding) ||
        action.source.configurationDigest !== previous.configurationDigest ||
        runtimeDigest(action.selected.binding) !== runtimeDigest(consumer.binding) ||
        action.selected.configurationDigest !== consumer.configurationDigest ||
        action.selected.baseConfigurationDigest !== consumer.baseConfigurationDigest ||
        action.selected.configRevision !== consumer.configRevision)
      held('launch-readiness-initial-action');
    return;
  }
  const retry = record.retries.find(row => row.commandId === consumer.actionId);
  const before = member.attempts[index - 1];
  if (!retry || retry.attemptId !== consumer.sourceAttemptId || !retry.memberIds.includes(consumer.memberId) ||
      retry.fingerprint !== consumer.inputDigest || before?.attemptId !== previous.sourceAttemptId ||
      !before.claimed || previous.actorDigest !== consumer.actorDigest ||
      runtimeDigest(previous.binding) !== runtimeDigest(consumer.binding) ||
      previous.configurationDigest !== consumer.configurationDigest || previous.configRevision !== consumer.configRevision)
    held('launch-readiness-initial-retry');
}

export function validateLaunchReadiness(record: TeamLaunchRecord): void {
  if (record.readiness === undefined) return;
  const parsed = launchReadinessSchema.safeParse(record.readiness);
  if (!parsed.success) held('launch-readiness-corrupt');
  const value = parsed.data;
  // Histories share the existing owners' finite additions/actions; there is no second history allowance.
  const historical = (record.memberActions?.length ?? 0) + (record.nativeAdditions?.length ?? 0) +
    (record.restorations?.length ?? 0) + (record.liveMembership?.length ?? 0) + record.retries.length;
  if (value.groups.length > 256 + historical || value.consumers.length > 256 + historical ||
      Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024)
    held('launch-readiness-budget');
  const active = value.consumers.filter(row => row.disposition !== 'retired');
  if (active.length > 256) held('launch-readiness-budget');
  for (const consumer of value.consumers) validateInitialReadiness(record, consumer, value.consumers);
  for (const consumer of active) {
    if (consumer.admissionOnly) continue;
    const member = record.definition.members.find(row => row.memberId === consumer.memberId);
    if (!member?.binding || member.skipped || runtimeDigest(member.binding) !== runtimeDigest(consumer.binding) ||
        member.configurationDigest !== consumer.configurationDigest || member.configRevision !== consumer.configRevision ||
        member.baseConfigurationDigest !== consumer.baseConfigurationDigest)
      held('launch-readiness-selection');
  }
}

/** Same launch record, before planning/materialization or MCP awaits. */
export function prepareReadinessCapture(store: Pick<TeamStore, 'read' | 'write'>, input: {
  launchId: string; rosterRevision: string; intent: JsonValue;
  capture: LaunchReadinessCaptureAdmission; groups: ModelReadinessReference[];
}): void {
  const target = `launches/${runtimeDigest(input.launchId)}.json`;
  if (store.read<TeamLaunchRecord>(target)) held('launch-readiness-capture-already-retained');
  if (input.capture.phase !== 'capturing' || input.capture.sourceDigest !== runtimeDigest(input.intent) ||
      input.capture.rosterRevision !== input.rosterRevision || Date.now() >= input.capture.cutoff)
    held('launch-readiness-capture-invalid');
  const definition: TeamLaunchDefinition = { launchId: input.launchId,
    rosterRevision: input.rosterRevision, capture: input.intent, members: [] };
  const record: TeamLaunchRecord = { schemaVersion: 1, definition,
    fingerprint: runtimeDigest(definition), members: [], retries: [],
    readiness: { schemaVersion: 1, capture: input.capture, groups: input.groups, consumers: [] } };
  validateLaunchReadiness(record);
  store.write(target, record);
}

export function assertLiveReadinessCapture(record: TeamLaunchRecord, live: LiveReadinessCapture | undefined,
  hostIncarnation: string, memberId?: string): void {
  const capture = record.readiness?.capture;
  if (!live || !capture || capture.phase === 'retired' || capture.commandId !== live.commandId ||
      capture.associationDigest !== live.associationDigest || capture.cutoff !== live.cutoff ||
      capture.hostIncarnation !== hostIncarnation || Date.now() >= capture.cutoff ||
      memberId !== undefined && !capture.targets.some(row => row.memberId === memberId && !row.retired))
    held('launch-readiness-capture-not-live');
}

export function isReadinessCapturePlaceholder(record: TeamLaunchRecord): boolean {
  const capture = record.readiness?.capture;
  return !!capture && capture.phase === 'capturing' && !record.worktreePreparation &&
    record.definition.members.length === 0 && record.members.length === 0 && record.retries.length === 0 &&
    !record.startCommandId && !record.preparation && !record.nativeAdditions?.length &&
    !record.memberActions?.length && !record.restorations?.length && !record.resumePreparations?.length &&
    record.fingerprint === runtimeDigest(record.definition) &&
    capture.sourceDigest === runtimeDigest(record.definition.capture);
}

/** Ordinary finalized records cannot enter this readiness-only placeholder upgrade. */
export function canFinalizeReadinessCapture(record: TeamLaunchRecord, definition: TeamLaunchDefinition,
  hostIncarnation: string): boolean {
  if (!isReadinessCapturePlaceholder(record)) return false;
  const capture = record.readiness!.capture!;
  if (capture.hostIncarnation !== hostIncarnation || Date.now() >= capture.cutoff ||
      record.definition.launchId !== definition.launchId)
    held('launch-readiness-capture-changed');
  const original = record.definition.capture, actual = definition.capture;
  if (!original || typeof original !== 'object' || Array.isArray(original) ||
      !actual || typeof actual !== 'object' || Array.isArray(actual)) held('launch-readiness-capture-changed');
  for (const key of ['commandId', 'rosterCommandId', 'configurationRevision', 'savedSettings', 'recipeSources'])
    if (runtimeDigest(original[key] ?? null) !== runtimeDigest(actual[key] ?? null))
      held('launch-readiness-capture-changed');
  const members = (value: JsonValue | undefined) => {
    if (!Array.isArray(value)) return held('launch-readiness-capture-changed');
    return value.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return held('launch-readiness-capture-changed');
      return { memberId: row.memberId, name: row.name, role: row.role, settings: row.settings };
    });
  };
  if (runtimeDigest(members(original.members)) !== runtimeDigest(members(actual.members)))
    held('launch-readiness-capture-changed');
  return true;
}

/** Only the existing first capture supplies this transition; read/replay never calls it. */
export function finishReadinessCapture(record: TeamLaunchRecord): TeamLaunchRecord {
  const capture = record.readiness?.capture;
  if (!capture || capture.phase !== 'capturing' || Date.now() >= capture.cutoff)
    held('launch-readiness-capture-expired');
  return { ...record, readiness: { ...record.readiness!, capture: { ...capture, phase: 'captured' } } };
}

export function readReadinessCapture(record: TeamLaunchRecord, expected: LocalModelReadinessCapture,
  now = Date.now()): LocalModelReadinessCaptureView | null {
  validateLaunchReadiness(record);
  const capture = record.readiness?.capture;
  if (record.definition.launchId !== expected.launchId ||
      record.definition.rosterRevision !== expected.rosterRevision)
    held('launch-readiness-capture-unavailable');
  if (!capture) return null;
  if (capture.phase === 'capturing') held('launch-readiness-capture-unavailable');
  return localModelReadinessCaptureViewSchema.parse({
    preparationId: capture.preparationId, captureCommandId: capture.commandId,
    launchId: expected.launchId, rosterRevision: expected.rosterRevision,
    captureDigest: runtimeDigest(record.definition.capture),
    remainingMs: capture.phase === 'retired' ? 0 : Math.max(0, Math.min(100000, Math.floor(capture.cutoff - now))),
    targets: capture.targets.filter(target => capture.phase === 'captured' && !target.retired && record.definition.members.some(member =>
      member.memberId === target.memberId && !member.skipped) && record.members.some(member =>
      member.memberId === target.memberId && member.attempts.some(attempt =>
        attempt.attemptId === member.currentAttemptId && !attempt.claimed)))
      .map(({ originalContext: _context, retired: _retired, ...target }) => target),
  });
}

export function attachLaunchReadiness(record: TeamLaunchRecord, input: {
  reference?: ModelReadinessReference;
  /** Restriction only: a first initial attachment cannot replace any retained same-attempt command. */
  initialAttemptId?: string;
  consumer: Omit<LaunchReadinessConsumer, 'consumerId' | 'disposition' | 'sourceAttemptId'> & { sourceAttemptId?: string };
}): TeamLaunchRecord {
  const target = record.members.find(row => row.memberId === input.consumer.memberId);
  if (!target) held('launch-readiness-target');
  const selected = { ...input.consumer, sourceAttemptId: input.consumer.sourceAttemptId ?? target.currentAttemptId };
  const consumer = consumerSchema.parse({ ...selected,
    consumerId: selected.initialProfile ? managementDigest(selected) : runtimeDigest(selected), disposition: 'pending' });
  const prior = record.readiness ?? { schemaVersion: 1 as const, groups: [], consumers: [] };
  const initial = `initial-${runtimeDigest({ launchId: record.definition.launchId, memberId: consumer.memberId })}`;
  if (input.initialAttemptId !== undefined || consumer.initialProfile && !consumer.initialProfile.predecessorConsumerId) {
    if (input.initialAttemptId !== undefined && input.initialAttemptId !== initial ||
        target.currentAttemptId !== initial || consumer.sourceAttemptId !== initial ||
        prior.consumers.some(row => row.memberId === consumer.memberId && row.sourceAttemptId === initial &&
          row.consumerId !== consumer.consumerId)) held('launch-readiness-initial-already-retained');
  }
  const existing = prior.consumers.find(row => row.consumerId === consumer.consumerId);
  if (existing) {
    if (existing.disposition === 'retired') held('launch-readiness-retired');
    const group = prior.groups.find(row => row.commandId === consumer.groupCommandId);
    if (runtimeDigest(group ?? null) !== runtimeDigest(input.reference ?? null))
      held('launch-readiness-reference-changed');
    return record;
  }
  if (!consumer.admissionOnly && !consumer.continuation && target.attempts.find(row => row.attemptId === target.currentAttemptId)?.claimed)
    held('launch-readiness-already-claimed');
  if (!consumer.continuation && !consumer.initialProfile && (consumer.cutoff === undefined || Date.now() >= consumer.cutoff) || input.reference &&
      (input.reference.commandId !== consumer.groupCommandId || Date.now() >= input.reference.expiresAt))
    held('launch-readiness-expired');
  if (consumer.groupCommandId === undefined && !consumer.continuation && !consumer.admissionOnly && !consumer.initialProfile)
    held('launch-readiness-reference-required');
  let groups = [...prior.groups];
  if (input.reference) {
    const reference = modelReadinessReferenceSchema.parse(input.reference);
    const old = groups.find(row => row.commandId === reference.commandId);
    if (old && runtimeDigest(old) !== runtimeDigest(reference)) held('launch-readiness-reference-changed');
    if (!old) groups.push(reference);
  }
  const admission = prior.consumers.find(row => row.actionId === consumer.actionId &&
    row.memberId === consumer.memberId && row.admissionOnly);
  if (admission && (admission.disposition !== 'pending' || consumer.admissionOnly ||
      admission.actorDigest !== consumer.actorDigest || admission.inputDigest !== consumer.inputDigest ||
      consumer.cutoff === undefined || admission.cutoff === undefined || consumer.cutoff > admission.cutoff))
    held('launch-readiness-action-changed');
  const consumers = prior.consumers.filter(row => row !== admission).map(row =>
    row.memberId === consumer.memberId && row.disposition !== 'retired'
      ? { ...row, disposition: 'retired' as const } : row);
  consumers.push(consumer);
  const capture = prior.capture;
  const targetCapture = capture?.targets.find(row => row.memberId === consumer.memberId);
  if (capture?.phase === 'captured' && targetCapture && !targetCapture.retired && input.reference &&
      input.reference.commandId === actualCaptureReadinessCommandId(
        capture.preparationId, capture.commandId, consumer.memberId)) {
    const parent = targetCapture.originalProbeCommandId;
    const referenced = consumers.some(row => row.groupCommandId === parent || row.policyCommandId === parent);
    const pendingSibling = capture.targets.some(row => row.originalProbeCommandId === parent && !row.retired &&
      !consumers.some(selected => selected.memberId === row.memberId && selected.groupCommandId ===
        actualCaptureReadinessCommandId(capture.preparationId, capture.commandId, row.memberId)));
    // Only an unused transfer reference is replaced. Its original probe/capture locator and all history survive.
    if (!referenced && !pendingSibling) groups = groups.filter(row => row.commandId !== parent);
  }
  const updated = { ...record, readiness: { ...prior, groups, consumers } };
  validateLaunchReadiness(updated);
  return updated;
}

export function selectedReadiness(record: TeamLaunchRecord, selected: {
  binding: RuntimeBinding; configRevision: string; configurationDigest: string;
}): { consumer: LaunchReadinessConsumer; attempt: LaunchAttempt; reference?: ModelReadinessReference } {
  validateLaunchReadiness(record);
  const consumer = record.readiness?.consumers.find(row => row.memberId === selected.binding.memberId &&
    row.disposition !== 'retired' && runtimeDigest(row.binding) === runtimeDigest(selected.binding));
  if (!consumer || consumer.admissionOnly || consumer.configRevision !== selected.configRevision ||
      consumer.configurationDigest !== selected.configurationDigest ||
      record.members.find(row => row.memberId === consumer.memberId)?.currentAttemptId !== consumer.sourceAttemptId)
    held('launch-readiness-required');
  const reference = record.readiness!.groups.find(row => row.commandId === consumer.groupCommandId);
  if (consumer.groupCommandId && !reference) held('launch-readiness-reference-required');
  const attempt = record.members.find(row => row.memberId === consumer.memberId)?.attempts
    .find(row => row.attemptId === consumer.sourceAttemptId);
  if (!attempt) held('launch-readiness-attempt');
  return { consumer: structuredClone(consumer), attempt: structuredClone(attempt),
    ...(reference ? { reference: structuredClone(reference) } : {}) };
}

/** Exact current attempt's historical provenance. This is never an allocation qualification. */
export function selectedReadinessSource(record: TeamLaunchRecord, selected: {
  binding: RuntimeBinding; configRevision: string; configurationDigest: string;
}) {
  validateLaunchReadiness(record);
  const member = record.definition.members.find(row => row.memberId === selected.binding.memberId);
  if (!member || runtimeDigest(member.binding) !== runtimeDigest(selected.binding) ||
      member.configRevision !== selected.configRevision || member.configurationDigest !== selected.configurationDigest)
    held('launch-readiness-source');
  const attempt = record.members.find(row => row.memberId === member.memberId)?.currentAttemptId;
  const matches = record.readiness?.consumers.filter(row => !row.admissionOnly &&
    row.sourceAttemptId === attempt && runtimeDigest(row.binding) === runtimeDigest(selected.binding) &&
    row.configurationDigest === selected.configurationDigest && row.configRevision === selected.configRevision) ?? [];
  if (matches.length > 1) held('launch-readiness-source-ambiguous');
  const consumer = matches[0];
  if (!consumer) return undefined;
  const commandId = consumer.groupCommandId ?? consumer.policyCommandId;
  const reference = record.readiness!.groups.find(row => row.commandId === commandId);
  if (commandId && !reference) held('launch-readiness-source');
  return { consumer: structuredClone(consumer), ...(reference ? { reference: structuredClone(reference) } : {}) };
}

export function consumeLaunchReadiness(record: TeamLaunchRecord, consumerId: string): TeamLaunchRecord {
  const current = record.readiness?.consumers.find(row => row.consumerId === consumerId);
  if (!current || current.disposition === 'retired' || !current.continuation && !current.initialProfile &&
      (current.cutoff === undefined || Date.now() >= current.cutoff))
    held('launch-readiness-expired');
  if (current.initialProfile) {
    const selected = selectedReadiness(record, { binding: current.binding,
      configRevision: current.configRevision, configurationDigest: current.configurationDigest });
    if (!selected.attempt.claimed || selected.attempt.noAllocation || selected.attempt.startedAtMs <= 0 ||
        selected.attempt.deadlineMs <= selected.attempt.startedAtMs || Date.now() >= selected.attempt.deadlineMs)
      held('launch-readiness-initial-claim');
  }
  if (current.disposition === 'consumed') return record;
  return { ...record, readiness: { ...record.readiness!, consumers: record.readiness!.consumers.map(row =>
    row.consumerId === consumerId ? { ...row, disposition: 'consumed' as const } : row) } };
}

export function retireLaunchReadiness(record: TeamLaunchRecord, memberId?: string): TeamLaunchRecord {
  if (!record.readiness) return record;
  return { ...record, readiness: { ...record.readiness,
    ...(record.readiness.capture ? { capture: { ...record.readiness.capture,
      ...(memberId === undefined ? { phase: 'retired' as const } : {
        targets: record.readiness.capture.targets.map(row => row.memberId === memberId ? { ...row, retired: true as const } : row),
      }),
    } } : {}),
    consumers: record.readiness.consumers.map(row => memberId === undefined || row.memberId === memberId
      ? { ...row, disposition: 'retired' as const } : row),
  } };
}

/** Same no-allocation retry only. A consumed row does not extend its original cutoff. */
export function reuseReadinessForRetry(record: TeamLaunchRecord, memberIds: readonly string[],
  actionId: string, attemptId: string, inputDigest: string): TeamLaunchRecord {
  if (!record.readiness) return record;
  const consumers = [...record.readiness.consumers];
  for (const memberId of memberIds) {
    const previous = consumers.find(row => row.memberId === memberId && row.disposition !== 'retired');
    if (!previous) continue;
    const reference = record.readiness.groups.find(row => row.commandId === previous.groupCommandId);
    if (previous.admissionOnly || !previous.continuation && !previous.initialProfile && (!reference || previous.cutoff === undefined ||
        Date.now() >= previous.cutoff || Date.now() >= reference.expiresAt)) held('launch-readiness-expired');
    const { consumerId: _id, disposition: _state, ...original } = previous;
    const selected = { ...original, actionId, inputDigest, sourceAttemptId: attemptId,
      ...(previous.initialProfile ? { initialProfile: { ...previous.initialProfile,
        predecessorConsumerId: previous.consumerId } } : {}) };
    consumers[consumers.indexOf(previous)] = { ...previous, disposition: 'retired' };
    consumers.push({ ...selected, consumerId: selected.initialProfile ? managementDigest(selected) : runtimeDigest(selected), disposition: 'pending' });
  }
  return { ...record, readiness: { ...record.readiness, consumers } };
}

/** Original selected Restart source lookup; the caller retains its existing writer fence. */
export function readFreshMemberSource(record: TeamLaunchRecord, binding: RuntimeBinding) {
  const member = record.definition.members.find((m) => m.memberId === binding.memberId);
  if (!member || runtimeDigest(member.binding) !== runtimeDigest(binding))
    throw new TeamLaunchError('hold', 'member-action-source');
  const row = record.memberActions?.find(
    (a) =>
      a.phase === 'selected' &&
      a.input.action === 'restart' &&
      runtimeDigest(a.selected.binding) === runtimeDigest(binding)
  );
  if (row) return structuredClone(row.source.binding!);
  const live = record.liveMembership?.find(item => item.phase === 'selected' &&
    runtimeDigest(item.selected?.binding ?? null) === runtimeDigest(binding));
  return live?.intent.source?.binding ? structuredClone(live.intent.source.binding) : undefined;
}
