import { channel } from 'node:diagnostics_channel';
import { z } from 'zod';
import { createModelReadinessTiming } from '../diagnostics/modelReadinessTiming.js';
import type { ModelReadinessAuthorityTiming } from '../diagnostics/modelReadinessTiming.js';
import { replaceRosterPayloadSchema } from '../team/rosterSchema.js';
import { teamModelProbeSelectionSchema } from './teamLaunchModelProbe.js';
import { teamModelProbeProfile, teamModelProbeEffort, teamModelProbeActionDigest } from './teamLaunchModelProbe.js';
import { actualCaptureReadinessCommandId, modelReadinessMechanismDigest } from '../team-launch/launchReadiness.js';
import { captureOpenCodeReadinessOrigin, captureReadinessPreparation,
  originalReadinessSubset } from '../adapters/providers/OpenCodeReadinessOrigin.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { nativeLocalReadinessPurpose } from '../management/ModelProbeOwner.js';
import { managementDigest, managementValuesEqual } from '../management/identity.js';
import { runtimeDigest } from '../runtime/identity.js';
import { inspectInitialRuntimeModelAdmission } from './initialRuntimeModelAdmission.js';
import { captureTeamProbePreparation, hasV1NativeModelProbeIdentity } from './captureTeamProbePreparation.js';
import type { TeamProbeManagement } from './captureTeamProbePreparation.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';

import type { ModelReadinessProbeScope, ModelReadinessReference, ReadinessPreparationAnchor,
  LocalModelReadinessOrigin, StoredModelProbe } from '../management/commandRecords.js';
import type { LocalModelReadinessPreparation } from '../management/commandRecords.js';
import type { OpenCodeManagementProfile } from '../management/profile.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { HostedTeam } from './MemberEntry.js';
import type { MemberEntry } from './MemberEntry.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { RuntimeCaptureSource } from './runtimeCaptureSource.js';
import type { LaunchReadinessCaptureAdmission } from '../team-launch/launchReadiness.js';
import type { CreateTeamLaunchPreparationInput } from '../team-registry/createLaunchContracts.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import { captureOpenCodeProbeAccount, captureOpenCodeProbeAccountInspection, prepareOpenCodeProbeFileKey } from './openCodeProbeAccount.js';
import type { PreparedModelFileKey } from './openCodeProbeAccount.js';
export { captureOpenCodeProbeAccount } from './openCodeProbeAccount.js';
export type { PreparedModelFileKey } from './openCodeProbeAccount.js';
import { projectReadinessLocatorSchema } from '../team-project-context/contracts.js';
import { assertProjectReadinessTransfer } from '../team-project-context/projectReadinessTransfer.js';
import { readCreatedProjectReadinessTransfer } from '../team-project-context/projectReadinessTransfer.js';
import type { ProjectModelReadinessTransfer } from '../team-project-context/projectReadinessTransfer.js';

const readinessRefusal = channel('agent-teams.legacy-host.first-refusal');
const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));

/** Main resolves these exact retained intents; Host validates every receipt and publication join. */
export const localModelReadinessTransferSchema = z.object({
  preparationId: id,
  remainingMs: z.number().int().min(1).max(100000),
  probes: z.array(z.object({ commandId: id, selection: teamModelProbeSelectionSchema }).strict())
    .min(1).max(256),
  roster: z.object({ commandId: id, expected: replaceRosterPayloadSchema }).strict(),
  projectContext: projectReadinessLocatorSchema.optional(),
}).strict().refine(value =>
  new Set(value.probes.map(row => JSON.stringify([row.commandId, row.selection]))).size === value.probes.length &&
  Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024);
export type LocalModelReadinessTransfer = z.infer<typeof localModelReadinessTransferSchema>;

/** Only CreateTeamLaunchCoordinator constructs this internal mapping after exact registry/roster publication. */
export type CreationModelReadinessTransfer = {
  kind: 'create'; input: CreateTeamLaunchPreparationInput; draftDigest: string; cutoff: number;
  roster: LocalModelReadinessTransfer['roster'];
  probes: { memberName: string; commandId: string; context: string }[];
};
export type CaptureModelReadinessTransfer = LocalModelReadinessTransfer | CreationModelReadinessTransfer | ProjectModelReadinessTransfer;
export type LocalModelReadinessAction = {
  preparation: LocalModelReadinessPreparation; owner: unknown; handleId: string; scope: unknown;
};
export interface PreparedModelReadinessReference {
  readonly reference: ModelReadinessReference;
  readonly fileKey?: PreparedModelFileKey;
}
type ReadinessLaunch = Pick<TeamLaunchOwner, 'readModelReadiness'>;
type FileHandoffOptions = {
  launch: ReadinessLaunch; entry: MemberEntry; hostIncarnation: string; assertCurrent(): void;
};
export interface MemberModelReadinessFileHandoff {
  readonly launch: ReadinessLaunch;
  readonly entry: MemberEntry;
  readonly prepared: PreparedModelReadinessReference & { readonly fileKey: PreparedModelFileKey };
  readonly bindingDigest: string;
  readonly configurationDigest: string;
  readonly baseConfigurationDigest: string;
  readonly requestDigest: string;
  readonly expectedAttemptId: string;
  readonly hostIncarnation: string;
  readonly cutoff: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function held(): never { throw new ManagementCommandError('held'); }

/** A competing invocation cannot retire a consumer while its original factory is queued. */
export function assertMemberModelReadinessFileHandoffsAvailable(entries: readonly MemberEntry[]): void {
  if (entries.some(entry => entry.modelReadinessFileHandoff !== undefined)) held();
}

function checkFileHandoff(options: FileHandoffOptions, handoff: MemberModelReadinessFileHandoff) {
  const { entry } = options;
  options.assertCurrent();
  if (handoff.launch !== options.launch || handoff.entry !== entry ||
      handoff.hostIncarnation !== options.hostIncarnation ||
      handoff.bindingDigest !== runtimeDigest(entry.binding) ||
      handoff.configurationDigest !== runtimeDigest(entry.profile) ||
      handoff.baseConfigurationDigest !== runtimeDigest(entry.baseProfile) ||
      handoff.requestDigest !== runtimeDigest(entry.config)) held();
  const current = options.launch.readModelReadiness({ binding: entry.binding,
    configRevision: entry.profile.configRevision, configurationDigest: handoff.configurationDigest });
  if (!current.reference || !managementValuesEqual(current.reference, handoff.prepared.reference) ||
      current.consumer.baseConfigurationDigest !== handoff.baseConfigurationDigest ||
      current.consumer.cutoff !== handoff.cutoff || Date.now() >= handoff.cutoff ||
      !handoff.prepared.fileKey.proof.filesCurrent()) held();
  options.assertCurrent();
  return current;
}

export function installMemberModelReadinessFileKey(options: FileHandoffOptions & {
  prepared: PreparedModelReadinessReference; expectedAttemptId: string;
}): MemberModelReadinessFileHandoff | undefined {
  options.assertCurrent();
  assertMemberModelReadinessFileHandoffsAvailable([options.entry]);
  const { fileKey, reference } = options.prepared, entry = options.entry;
  if (!fileKey) return undefined;
  if (fileKey.commandId !== reference.commandId || fileKey.context !== reference.context) held();
  const current = options.launch.readModelReadiness({ binding: entry.binding,
    configRevision: entry.profile.configRevision, configurationDigest: runtimeDigest(entry.profile) });
  if (current.consumer.cutoff === undefined) held();
  const handoff: MemberModelReadinessFileHandoff = Object.freeze({
    launch: options.launch, entry, hostIncarnation: options.hostIncarnation,
    expectedAttemptId: options.expectedAttemptId, cutoff: current.consumer.cutoff,
    prepared: Object.freeze({ reference: Object.freeze(structuredClone(reference)), fileKey: Object.freeze({ ...fileKey }) }),
    bindingDigest: runtimeDigest(entry.binding), configurationDigest: runtimeDigest(entry.profile),
    baseConfigurationDigest: runtimeDigest(entry.baseProfile), requestDigest: runtimeDigest(entry.config),
  });
  checkFileHandoff(options, handoff);
  assertMemberModelReadinessFileHandoffsAvailable([entry]);
  entry.modelReadinessFileHandoff = handoff;
  return handoff;
}

export function readMemberModelReadinessFileKey(options: FileHandoffOptions): PreparedModelFileKey | undefined {
  const handoff = options.entry.modelReadinessFileHandoff;
  if (!handoff) return undefined;
  checkFileHandoff(options, handoff);
  return handoff.prepared.fileKey;
}

function pendingFileHandoff(current: ReturnType<ReadinessLaunch['readModelReadiness']>, handoff: MemberModelReadinessFileHandoff): boolean {
  const { attempt, consumer } = current;
  return consumer.disposition === 'pending' && attempt.attemptId === handoff.expectedAttemptId &&
    attempt.hostIncarnation === handoff.hostIncarnation && attempt.claimed && !attempt.noAllocation &&
    attempt.status === 'pending-bootstrap' && attempt.reason === 'opening' && attempt.startedAtMs > 0 &&
    attempt.deadlineMs > attempt.startedAtMs && Date.now() < attempt.deadlineMs;
}

export function takeMemberModelReadinessFileKey(options: FileHandoffOptions & {
  config: MemberEntry['config'];
}): PreparedModelFileKey | undefined {
  const handoff = options.entry.modelReadinessFileHandoff;
  if (!handoff) return undefined;
  if (runtimeDigest(options.config) !== handoff.requestDigest ||
      !pendingFileHandoff(checkFileHandoff(options, handoff), handoff) ||
      options.entry.modelReadinessFileHandoff !== handoff) held();
  delete options.entry.modelReadinessFileHandoff;
  return handoff.prepared.fileKey;
}

export function settleMemberModelReadinessFileHandoff(options: FileHandoffOptions & {
  handoff: MemberModelReadinessFileHandoff | undefined;
}): void {
  const { entry, handoff } = options;
  if (!handoff || entry.modelReadinessFileHandoff !== handoff) return;
  try { if (pendingFileHandoff(checkFileHandoff(options, handoff), handoff)) return; }
  catch { /* A failed read only discards this invocation's unused material. */ }
  if (entry.modelReadinessFileHandoff === handoff) delete entry.modelReadinessFileHandoff;
}

function sameCapturedModel(profile: OpenCodeManagementProfile, providerId: string,
  actual: string, expected: string): boolean {
  // Private producers persist profile.model unchanged. A pre-fix V1 probe could have
  // tested the suffix despite retaining the nested native input, so it cannot qualify.
  return actual === expected && (profile.nativeGeneration === 'v2' ||
    !expected.startsWith(providerId + '/') || hasV1NativeModelProbeIdentity(profile));
}

/** Caller already validated its exact product publication; this never admits a replacement profile. */
export async function capturePreparedModelReference(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  profile: RuntimeMemberProfile;
  commandId: string;
  context: string;
  kind?: 'native';
  isCurrent(): boolean;
  withAccountRead?: <T>(read: () => T) => T;
  observeAccount?(account: ReturnType<typeof captureOpenCodeProbeAccount>): void;
}): Promise<PreparedModelReadinessReference> {
  // V1/non-file account fencing retains its original single qualified snapshot.
  if (options.profile.provider !== 'opencode' || options.profile.nativeGeneration !== 'v2')
    return { reference: readPreparedModelReference(options) };
  const readOriginal = () => options.management.probes.readRetainedProbe(options.commandId, options.context);
  const original = readOriginal();
  if (original.nativeFileKeyWitness === undefined) return { reference: readPreparedModelReference(options) };
  const profile = { ...teamModelProbeProfile(options.profile),
    profileId: original.profileId, configRevision: original.configRevision };
  if (profile.provider !== 'opencode') held();
  const fileKey = await prepareOpenCodeProbeFileKey({ ...options, profile, original, readOriginal });
  if (!fileKey) held();
  return { reference: readPreparedModelReference({ ...options, fileKey }), fileKey };
}

function readPreparedModelReference(options: Parameters<typeof capturePreparedModelReference>[0] & { fileKey?: PreparedModelFileKey },
  memberInspection = false, accountTiming?: () => () => void): ModelReadinessReference {
  return options.management.probes.captureReadinessReference(options.commandId, options.context, saved => {
    const inspect = () => {
    // The qualified invocation's fresh receipt also supplies candidate validation.
    // Its source/authority checks share the account fence before every expiry gate.
    const original = saved;
    const candidate = { ...teamModelProbeProfile(options.profile),
      profileId: original.profileId, configRevision: original.configRevision };
    if (candidate.provider !== 'opencode' || options.profile.provider !== 'opencode' || !options.isCurrent() ||
        original.providerId !== options.profile.nativeOptions.providerId ||
        !sameCapturedModel(candidate, original.providerId, original.modelId, options.profile.model) ||
        original.effort !== options.profile.nativeOptions.variant ||
        (options.kind !== 'native' && original.purpose !== nativeLocalReadinessPurpose) ||
        (original.purpose === undefined && original.readinessScope?.kind !== 'native') ||
        modelReadinessMechanismDigest(candidate) !== original.readinessScope?.mechanismDigest) held();
    let inspected: ReturnType<typeof captureOpenCodeProbeAccountInspection> = undefined;
    if (saved.readiness || saved.readinessScope?.accountDigest !== undefined || saved.nativeFileKeyWitness !== undefined) {
      const endAccount = accountTiming?.();
      try {
        inspected = captureOpenCodeProbeAccountInspection(candidate, saved, options.isCurrent, saved,
          saved.localModelReadinessOrigin, memberInspection ? () => options.management.readinessTarget(candidate) : undefined,
          options.fileKey);
      } finally { endAccount?.(); }
    }
    if (inspected?.memberReference) {
      options.observeAccount?.(inspected.account);
      return inspected.memberReference;
    }
    const account = inspected?.account;
    const origin = inspected?.origin ?? (saved.localModelReadinessOrigin
      ? captureOpenCodeReadinessOrigin(saved.localModelReadinessOrigin, candidate, saved.providerId,
        options.isCurrent) : undefined);
    if (!options.isCurrent() || account && !account.isCurrent() || saved.nativeFileKeyWitness !== undefined && !account) held();
    options.observeAccount?.(account);
    return { target: options.management.readinessTarget(candidate),
      originCurrent: (!origin || origin.isCurrent()) && options.isCurrent(),
      ...(account ? { accountDigest: account.digest } : {}) };
    };
    return options.withAccountRead ? options.withAccountRead(inspect) : inspect();
  });
}

export function assertPreparedMemberModelReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  profile: RuntimeMemberProfile; prepared: PreparedModelReadinessReference; isCurrent(): boolean;
  withAccountRead?: <T>(read: () => T) => T;
}): void {
  const { reference, fileKey } = options.prepared;
  const current = readPreparedModelReference({ ...options, commandId: reference.commandId, context: reference.context,
    ...(reference.purpose === 'ordinary' ? { kind: 'native' as const } : {}), ...(fileKey ? { fileKey } : {}) });
  if (!managementValuesEqual(reference, current)) held();
}

/** An existing consumer is observed only; a retry advances it solely in the launch owner. */
export async function prepareMemberModelReadiness(options: {
  management?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  launch: TeamLaunchOwner; entry: MemberEntry; isCurrent(): boolean;
  withAccountRead?: <T>(read: () => T) => T;
}): Promise<PreparedModelReadinessReference | undefined> {
  if (!options.isCurrent()) held();
  const selected = { binding: structuredClone(options.entry.binding), configRevision: options.entry.profile.configRevision,
    configurationDigest: runtimeDigest(options.entry.profile) };
  const original = options.launch.readModelReadiness(selected);
  if (original.consumer.continuation || original.consumer.initialProfile) return undefined;
  if (!options.management || !original.reference) held();
  const prepared = await capturePreparedModelReference({ ...options, management: options.management,
    profile: options.entry.profile, commandId: original.reference.commandId, context: original.reference.context,
    ...(original.reference.purpose === 'ordinary' ? { kind: 'native' as const } : {}) });
  if (!options.isCurrent() || !managementValuesEqual(original, options.launch.readModelReadiness(selected)) ||
      !managementValuesEqual(original.reference, prepared.reference)) held();
  return prepared;
}

export function attachMemberModelReadiness(options: {
  launch: Pick<TeamLaunchOwner, 'attachModelReadiness'>; entry: MemberEntry; reference: ModelReadinessReference;
  commandId: string; actorDigest: string; inputDigest: string; cutoff: number;
  policyCommandId?: string;
  authorized?: <T>(operation: () => T) => T;
}): void {
  const { entry, launch, reference } = options;
  launch.attachModelReadiness({ reference, consumer: {
    memberId: entry.profile.memberId, actionId: options.commandId,
    actorDigest: options.actorDigest, inputDigest: options.inputDigest,
    binding: entry.binding,
    baseConfigurationDigest: runtimeDigest(entry.baseProfile),
    configurationDigest: runtimeDigest(entry.profile), configRevision: entry.profile.configRevision,
    cutoff: Math.min(options.cutoff, reference.expiresAt), groupCommandId: reference.commandId,
    ...(options.policyCommandId ? { policyCommandId: options.policyCommandId } : {}),
  } }, options.authorized);
}

/** Await only groups already admitted by the original first capture/Main child calls. */
export async function prepareCapturedLaunchReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  launch: TeamLaunchOwner; entries: readonly MemberEntry[]; commandId: string; payload: unknown;
  principalId: string; isCurrent(): boolean;
}): Promise<{ references: Map<string, PreparedModelReadinessReference>; cutoff: number } | undefined> {
  const summary = options.launch.read();
  const eligible = new Set(options.launch.readModelProbeSelection('read').memberIds);
  const selected = options.entries.filter(entry => entry.profile.provider === 'opencode' &&
    eligible.has(entry.profile.memberId) &&
    summary.members.some(row => row.memberId === entry.profile.memberId &&
      runtimeDigest(row.binding) === runtimeDigest(entry.binding) &&
      row.attempt.status !== 'skipped' && !row.attempt.claimed));
  if (!selected.length) return;
  const capture = options.launch.readModelReadinessAdmission();
  if (!capture) held();
  options.launch.assertModelReadinessCapture();
  const current = () => {
    try {
      for (const entry of selected) options.launch.assertModelReadinessCapture(entry.profile.memberId);
      return options.isCurrent() && Date.now() < capture.cutoff;
    }
    catch { return false; }
  };
  const references = new Map<string, PreparedModelReadinessReference>();
  for (const entry of selected) {
    const target = capture.targets.find(row => row.memberId === entry.profile.memberId);
    if (!target || target.retired || runtimeDigest(entry.team.definition.binding) !== capture.teamBindingDigest) held();
    const changed = target.originalWorkspace !== entry.profile.cwd;
    const commandId = changed
      ? actualCaptureReadinessCommandId(capture.preparationId, capture.commandId, entry.profile.memberId)
      : target.originalProbeCommandId;
    const selection = { launchId: summary.launchId,
      rosterRevision: object(options.payload) ? options.payload.rosterRevision : undefined,
      memberId: entry.profile.memberId, model: entry.profile.model,
      ...(teamModelProbeEffort(entry.profile) === undefined ? {} : { effort: teamModelProbeEffort(entry.profile) }) };
    const original = changed
      ? options.management.probes.readScopedProbe(commandId, capture.teamBindingDigest, runtimeDigest(selection))
      : options.management.probes.readRetainedProbe(commandId, target.originalContext);
    if (changed) await options.management.probes.awaitPrepared(commandId, original.context!);
    if (!current()) held();
    const prepared = await capturePreparedModelReference({ management: options.management, profile: entry.profile,
      commandId, context: original.context!, isCurrent: current });
    if (!changed && runtimeDigest(options.launch.readModelReadinessGroup(commandId) ?? null) !== runtimeDigest(prepared.reference)) held();
    references.set(entry.profile.memberId, prepared);
  }
  if (!current()) held();
  return { references, cutoff: capture.cutoff };
}

/** Synchronous allocation check; no preparation/native effects are allowed at this boundary. */
export function inspectMemberModelReadiness(options: {
  management?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  launch: TeamLaunchOwner; entry: MemberEntry; assertCurrent(): void;
  withAccountRead?: <T>(read: () => T) => T;
  authorityTiming?: ModelReadinessAuthorityTiming;
  fileKey?: PreparedModelFileKey;
  hostIncarnation: string; phase?: 'preclaim' | 'allocation';
}): { assertCurrent(): void; consumerId: string; kind: 'preparation' | 'continuation' | 'initial';
  reference?: ModelReadinessReference; assertReadinessCredential?(scopeDigest: string): void } {
  const { entry, launch } = options;
  const selected = { binding: entry.binding, configRevision: entry.profile.configRevision,
    configurationDigest: runtimeDigest(entry.profile) };
  const original = launch.readModelReadiness(selected);
  if (original.consumer.initialProfile) return inspectInitialRuntimeModelAdmission({ ...options,
    phase: options.phase ?? 'preclaim' });
  const observedAccount: { value?: NonNullable<ReturnType<typeof captureOpenCodeProbeAccount>> } = {};
  let refusalObserved = false;
  const timings = createModelReadinessTiming(readinessRefusal);
  let authorityTiming: ModelReadinessAuthorityTiming | undefined;
  try { authorityTiming = options.authorityTiming; } catch { /* Optional observation cannot replace an authority check. */ }
  const current = () => {
    let phase = 'initial-authority', reason: 'held' | 'threw' = 'threw';
    let cutoff: number | null = null, observedAt: number | null = null;
    let failed = false;
    const timing = timings.begin(!refusalObserved, authorityTiming);
    const { boundary, beginAccount } = timing;
    try {
      options.assertCurrent(); phase = 'read-consumer';
      boundary?.('readConsumer');
      const current = launch.readModelReadiness(selected), consumer = current.consumer;
      boundary?.();
      phase = 'identity';
      if (consumer.consumerId !== original.consumer.consumerId ||
          consumer.baseConfigurationDigest !== runtimeDigest(entry.baseProfile)) { reason = 'held'; held(); }
      phase = 'continuation';
      if (consumer.continuation) {
        const restore = entry.selection?.restore;
        if (!restore || restore.reference !== consumer.continuation.reference ||
            runtimeDigest(restore.sourceBinding) !== runtimeDigest(consumer.continuation.sourceBinding)) { reason = 'held'; held(); }
        return;
      }
      phase = 'requirements';
      if (!options.management || !current.reference || consumer.cutoff === undefined) { reason = 'held'; held(); }
      phase = 'cutoff';
      if ((observedAt = Date.now()) >= (cutoff = consumer.cutoff)) { reason = 'held'; held(); }
      phase = 'reference';
      boundary?.('reference');
      const observed = readPreparedModelReference({ management: options.management, profile: entry.profile,
        commandId: current.reference.commandId, context: current.reference.context,
        ...(options.fileKey ? { fileKey: options.fileKey } : {}),
        ...(options.withAccountRead ? { withAccountRead: options.withAccountRead } : {}),
        ...(current.reference.purpose === 'ordinary' ? { kind: 'native' as const } : {}),
        observeAccount: value => { if (value) observedAccount.value = value; else delete observedAccount.value; },
        isCurrent: () => {
          const endAuthority = timing.beginAccountAuthority();
          try { options.assertCurrent(); return true; } catch { return false; }
          finally { endAuthority(); }
        } }, true, beginAccount);
      boundary?.();
      phase = 'equality';
      if (runtimeDigest(observed) !== runtimeDigest(current.reference)) { reason = 'held'; held(); }
      boundary?.('finalAuthority');
      phase = 'final-authority'; options.assertCurrent();
    } catch (error) {
      failed = true; throw error;
    } finally {
      timing.finish();
      if (failed && !refusalObserved) {
        refusalObserved = true;
        try { if (readinessRefusal.hasSubscribers) readinessRefusal.publish({
          kind: 'consumer', actionDigest: runtimeDigest(original.consumer.actionId),
          groupDigest: runtimeDigest({ commandDigest: runtimeDigest(original.consumer.groupCommandId ?? null),
            contextDigest: runtimeDigest(original.reference?.context ?? null) }), bindingDigest: managementDigest(selected.binding),
          consumerId: original.consumer.consumerId, phase, reason, cutoff, observedAt,
          currentCalls: timings.snapshot(),
        }); } catch { /* Original TEST subscriber handles its own errors; preserve this refusal. */ }
      }
    }
  };
  current();
  return { assertCurrent: current, consumerId: original.consumer.consumerId,
    kind: original.consumer.continuation ? 'continuation' : 'preparation',
    ...(original.reference ? { reference: original.reference } : {}),
    ...(!original.consumer.continuation && observedAccount.value?.nativeCredentialScopeDigest !== undefined ? {
      assertReadinessCredential(scopeDigest: string) {
        current();
        const account = observedAccount.value;
        if (!account) held();
        const read = () => account.isCurrent();
        if (!(options.withAccountRead ? options.withAccountRead(read) : read()) ||
            account.nativeCredentialScopeDigest !== scopeDigest) held();
      },
    } : {}) };
}

export function consumeMemberModelReadiness(options: Parameters<typeof inspectMemberModelReadiness>[0]) {
  const captured = inspectMemberModelReadiness({ ...options, phase: 'allocation' });
  options.launch.consumeModelReadiness(captured.consumerId);
  return captured;
}

/** The existing Runtime checkpoint validator owns continuation; this adds no fresh proof or clock. */
export function attachCheckpointModelReadiness(launch: TeamLaunchOwner, entry: MemberEntry,
  commandId: string, assertCurrent: () => void, policyCommandId?: string): void {
  if (entry.profile.provider !== 'opencode') return;
  assertCurrent();
  const restore = entry.selection?.restore;
  if (!restore || restore.commandId !== commandId) held();
  const previous = launch.readModelReadinessSource({ binding: entry.binding,
    configRevision: entry.profile.configRevision, configurationDigest: runtimeDigest(entry.profile) });
  if (previous?.consumer.continuation) {
    if (previous.consumer.disposition === 'retired' ||
        runtimeDigest(previous.consumer.continuation) !== runtimeDigest({ reference: restore.reference,
          sourceBinding: restore.sourceBinding })) held();
    return;
  }
  launch.attachModelReadiness({ consumer: {
    memberId: entry.profile.memberId, actionId: commandId,
    actorDigest: runtimeDigest({ restore, binding: entry.binding }), inputDigest: runtimeDigest(restore),
    binding: entry.binding, baseConfigurationDigest: runtimeDigest(entry.baseProfile),
    configurationDigest: runtimeDigest(entry.profile), configRevision: entry.profile.configRevision,
    continuation: { reference: restore.reference, sourceBinding: restore.sourceBinding },
    ...(policyCommandId ? { policyCommandId } : {}),
  } });
  assertCurrent();
}

/** Only the original captured native action can use these unchanged source facts for a new Restart. */
export async function captureNativeRestartReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  launch: Pick<TeamLaunchOwner, 'readModelReadinessSource'>; entry: MemberEntry; isCurrent(): boolean;
  cutoff: number;
}) {
  const { entry, management } = options;
  const selected = { binding: structuredClone(entry.binding), configRevision: entry.profile.configRevision,
    configurationDigest: runtimeDigest(entry.profile) };
  const readSource = () => options.launch.readModelReadinessSource(selected);
  const source = readSource();
  if (!source?.reference || source.consumer.baseConfigurationDigest !== runtimeDigest(entry.baseProfile)) held();
  const reference = source.reference;
  const profile = { ...teamModelProbeProfile(entry.profile),
    profileId: reference.profileId, configRevision: reference.configRevision };
  if (profile.provider !== 'opencode' || entry.profile.provider !== 'opencode' ||
      modelReadinessMechanismDigest(profile) !== reference.mechanismDigest) held();
  const providerId = entry.profile.nativeOptions.providerId, model = entry.profile.model;
  const current = () => options.isCurrent() && Date.now() < options.cutoff &&
    selected.configurationDigest === runtimeDigest(entry.profile) &&
    runtimeDigest(selected.binding) === runtimeDigest(entry.binding) &&
    source.consumer.baseConfigurationDigest === runtimeDigest(entry.baseProfile) && managementValuesEqual(source, readSource() ?? null);
  const readOriginal = () => management.probes.readRetainedProbe(reference.commandId, reference.context);
  const initial = readOriginal();
  const fileKey = await prepareOpenCodeProbeFileKey({ profile, original: initial, readOriginal, isCurrent: current });
  const read = () => management.probes.readReadinessProvenance(reference, saved => {
    if (!current() || saved.providerId !== providerId ||
        !sameCapturedModel(profile, providerId, saved.modelId, model) ||
        saved.effort !== profile.variant) held();
    const policy = saved.localModelReadinessOrigin
      ? captureOpenCodeReadinessOrigin(saved.localModelReadinessOrigin, profile, providerId, current)
      : undefined;
    const account = saved.readiness || saved.readinessScope?.accountDigest !== undefined || saved.nativeFileKeyWitness !== undefined
      ? captureOpenCodeProbeAccount(profile, saved, current, saved, undefined, fileKey) : undefined;
    if (saved.nativeFileKeyWitness !== undefined && !account) held();
    return { target: management.readinessTarget(profile),
      originCurrent: current() && (policy?.isCurrent() ?? true) && (account?.isCurrent() ?? true),
      ...(account ? { accountDigest: account.digest } : {}) };
  });
  const original = read();
  if (!managementValuesEqual(initial, original)) held();
  return { reference, original, assertCurrent: () => { if (!managementValuesEqual(original, read())) held(); } };
}

/** One explicit action attachment in the existing launch record, before Stop or workspace awaits. */
export function captureActionModelReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget' | 'admitTeamProbeProfile'>;
  launch: Pick<TeamLaunchOwner, 'attachModelReadiness' | 'readModelReadinessAction'>;
  targets: readonly { entry: MemberEntry; profile: RuntimeMemberProfile; binding: RuntimeBinding }[];
  commandId: string; payload: unknown; actorDigest: string; readiness?: LocalModelReadinessAction;
  nativeSource?: Awaited<ReturnType<typeof captureNativeRestartReadiness>>;
  admittedAt?: number;
  captureProcessOrigin?(entry: MemberEntry): RuntimeSourceProcessOrigin | undefined;
  authorized?: <T>(operation: () => T) => T;
  assertCurrent(): void;
}) {
  const admittedAt = options.admittedAt ?? Date.now(), payload = structuredClone(options.payload), inputDigest = runtimeDigest(payload);
  const targets = options.targets.filter(row => row.profile.provider === 'opencode');
  if (!targets.length || targets.length > 256 || options.readiness && options.nativeSource) held();
  options.assertCurrent();
  const captured = targets.map(row => {
    const processOrigin = options.captureProcessOrigin?.(row.entry);
    return { ...row, profile: structuredClone(row.profile),
      binding: structuredClone(row.binding), sourceBinding: structuredClone(row.entry.binding),
      sourceProfile: runtimeDigest(row.entry.profile),
      ...(processOrigin ? { processOrigin: structuredClone(processOrigin) } : {}) };
  });
  const firstTeam = runtimeDigest(captured[0]!.entry.team.definition.binding);
  if (captured.some(row => runtimeDigest(row.entry.team.definition.binding) !== firstTeam ||
      options.launch.readModelReadinessAction(options.commandId, row.entry.profile.memberId))) held();
  const groups = new Map<string, typeof captured>();
  for (const target of captured) {
    if (target.profile.provider !== 'opencode') held();
    const profile = teamModelProbeProfile(target.profile);
    const key = runtimeDigest({ mechanism: modelReadinessMechanismDigest(profile),
      providerId: target.profile.nativeOptions.providerId, model: target.profile.model,
      effort: teamModelProbeEffort(target.profile) });
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const groupCommand = (key: string) => `action-probe-${runtimeDigest({ commandId: options.commandId,
    team: firstTeam, key })}`;
  const firstCommand = groupCommand(groups.keys().next().value!);
  const prepared = options.readiness ? captureReadinessPreparation(options.readiness.preparation, {
    kind: 'team', owner: options.readiness.owner,
    contextId: options.readiness.preparation.origin.contextId, commandId: options.commandId,
    selection: { handleId: options.readiness.handleId, scope: options.readiness.scope, payload },
    workspaces: captured.map(row => row.profile.cwd),
    targets: captured.map(row => ({ workspace: row.profile.cwd,
      providerId: row.profile.provider === 'opencode' ? row.profile.nativeOptions.providerId : '' })),
    anchorCommandId: firstCommand, original: options.management.probes.readPreparation(firstCommand), admittedAt,
  }) : undefined;
  if (!prepared && !options.nativeSource || options.nativeSource && captured.length !== 1) held();
  options.nativeSource?.assertCurrent();
  const cutoff = Math.min(prepared?.anchor.expiresAt ?? Infinity,
    ...captured.map(row => admittedAt + (teamModelProbeProfile(row.profile).modelProbeTimeoutMs ?? 90000)));
  if (Date.now() >= cutoff) held();
  assertMemberModelReadinessFileHandoffsAvailable(captured.map(row => row.entry));
  for (const target of captured) options.launch.attachModelReadiness({ consumer: {
    memberId: target.entry.profile.memberId, actionId: options.commandId,
    actorDigest: options.actorDigest, inputDigest, binding: target.sourceBinding,
    baseConfigurationDigest: runtimeDigest(target.entry.baseProfile),
    configurationDigest: target.sourceProfile, configRevision: target.entry.profile.configRevision,
    cutoff, admissionOnly: true,
  } }, options.authorized);
  const current = () => {
    try {
      options.assertCurrent();
      options.nativeSource?.assertCurrent();
      return Date.now() < cutoff && captured.every(target => {
        const row = options.launch.readModelReadinessAction(options.commandId, target.entry.profile.memberId);
        return row?.admissionOnly === true && row.disposition === 'pending' && row.cutoff === cutoff &&
          row.actorDigest === options.actorDigest && row.inputDigest === inputDigest &&
          runtimeDigest(row.binding) === runtimeDigest(target.sourceBinding) &&
          runtimeDigest(target.entry.binding) === runtimeDigest(target.sourceBinding) &&
          (runtimeDigest(target.entry.profile) === target.sourceProfile ||
            runtimeDigest(target.entry.profile) === runtimeDigest(target.profile)) &&
          row.baseConfigurationDigest === runtimeDigest(target.entry.baseProfile);
      });
    } catch { return false; }
  };
  let invoked = false;
  return { cutoff, inputDigest, async prepare() {
    if (invoked || !current()) held();
    invoked = true;
    const references = new Map<string, PreparedModelReadinessReference>();
    for (const [key, rows] of groups) {
      const target = rows[0]!, profile = target.profile;
      if (profile.provider !== 'opencode') held();
      const commandId = groupCommand(key);
      const selection = { payload, targets: rows.map(row => ({ binding: row.binding,
        profile: runtimeDigest(row.profile) })) };
      const context = runtimeDigest({ commandId, selection, actor: options.actorDigest });
      const original = options.nativeSource?.original;
      const origin = prepared ? originalReadinessSubset(prepared.origin, profile.cwd, profile.nativeOptions.providerId)
        : original?.localModelReadinessOrigin;
      const anchor = prepared?.anchor ?? (origin && original?.localModelReadinessPreparation ? {
        ...original.localModelReadinessPreparation, commandId: options.commandId,
        selectionDigest: runtimeDigest(selection), anchorCommandId: firstCommand, expiresAt: cutoff,
      } : undefined);
      if (origin && !anchor) held();
      const reference = await prepareTeamModelReadiness({ management: options.management, profile,
        commandId, context, cutoff, isCurrent: current,
        ...(target.processOrigin ? { processOrigin: target.processOrigin } : {}),
        ...(anchor && origin ? { prepared: { anchor: { ...anchor, expiresAt: cutoff }, origin } } : {}),
        scope: { schemaVersion: 1, kind: options.nativeSource ? 'native' : 'team',
          teamBindingDigest: firstTeam, actionDigest: runtimeDigest({ commandId: options.commandId,
            actor: options.actorDigest, inputDigest }), selectionDigest: runtimeDigest(selection),
          sourceRevision: runtimeDigest(target.entry.team.capture ?? target.entry.team.definition),
          rosterRevision: object(payload) && typeof payload.rosterRevision === 'string'
            ? payload.rosterRevision : runtimeDigest(target.sourceBinding),
          mechanismDigest: modelReadinessMechanismDigest(teamModelProbeProfile(profile)),
          workspace: profile.cwd, cutoff,
          destinationKeys: rows.map(row => runtimeDigest({ launchId: row.binding.runId, memberId: row.entry.profile.memberId })),
        } });
      for (const row of rows) references.set(row.entry.profile.memberId, reference);
    }
    if (!current()) held();
    return references;
  } };
}

/** One original explicit Host action; no polling, renewal, latest selection or cold admission. */
export async function prepareTeamModelReadiness(options: {
  management: TeamProbeManagement & Pick<ProviderManagementCoordinator, 'readinessTarget'>;
  profile: RuntimeMemberProfile;
  commandId: string;
  context: string;
  cutoff: number;
  scope: ModelReadinessProbeScope;
  prepared?: { anchor: ReadinessPreparationAnchor; origin?: LocalModelReadinessOrigin };
  processOrigin?: RuntimeSourceProcessOrigin;
  isCurrent(): boolean;
}): Promise<PreparedModelReadinessReference> {
  const profile = teamModelProbeProfile(options.profile);
  if (profile.provider !== 'opencode' || !options.isCurrent() || Date.now() >= options.cutoff ||
      options.scope.cutoff !== options.cutoff ||
      options.scope.workspace !== profile.cwd ||
      options.scope.mechanismDigest !== modelReadinessMechanismDigest(profile)) held();
  const current = () => options.isCurrent() && Date.now() < options.cutoff;
  options.management.admitTeamProbeProfile(profile);
  const input = { commandId: options.commandId, profileId: profile.profileId,
    configRevision: profile.configRevision, context: options.context,
    providerId: options.profile.provider === 'opencode' ? options.profile.nativeOptions.providerId : '',
    modelId: options.profile.model,
    ...(profile.variant === undefined ? {} : { effort: profile.variant }) };
  const account = options.prepared?.origin || profile.nativeGeneration === 'v2'
    ? captureOpenCodeProbeAccount(profile, input, current, undefined, options.prepared?.origin) : undefined;
  const scope = { ...options.scope, ...(account ? { accountDigest: account.digest } : {}) };
  options.management.probes.startPrepared(input, current, options.prepared, scope,
    captureTeamProbePreparation(options.management, profile, options.processOrigin));
  await options.management.probes.awaitPrepared(input.commandId, input.context);
  if (!current()) held();
  return capturePreparedModelReference({ ...options,
    ...(options.scope.kind === 'native' ? { kind: 'native' as const } : {}), isCurrent: current });
}

/** Exact original publication bridge; the old pre-CAS roster callback is deliberately not re-run. */
export async function captureLaunchModelReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  team: HostedTeam; source: RuntimeCaptureSource; profiles: RuntimeMemberProfile[];
  principalId: string; hostIncarnation: string; transfer: CaptureModelReadinessTransfer;
  admittedAt: number; isCurrent(): boolean;
}): Promise<{ capture: LaunchReadinessCaptureAdmission; groups: ModelReadinessReference[] }> {
  const { team, source, transfer } = options;
  const creating = 'kind' in transfer && transfer.kind === 'create';
  const createdProjectSettings = creating ? readCreatedProjectReadinessTransfer(transfer) : undefined;
  const project = 'kind' in transfer && transfer.kind === 'project' ? transfer : undefined;
  const savedTransfer = transfer as LocalModelReadinessTransfer | ProjectModelReadinessTransfer;
  if (project) assertProjectReadinessTransfer(project);
  if (!creating && !project) localModelReadinessTransferSchema.parse(transfer);
  const teamBindingDigest = runtimeDigest(team.definition.binding);
  const actor = team.owner.withLaunchAuthority(options.principalId, 'control', revision => revision);
  const receipt = team.connection.lookupRoster(transfer.roster.commandId, transfer.roster.expected);
  if (!receipt || transfer.roster.commandId !== source.rosterCommandId ||
      receipt.revision !== source.configurationRevision ||
      team.connection.readRoster().revision !== receipt.revision) held();
  const current = () => {
    try { if (project) assertProjectReadinessTransfer(project);
      if (creating) readCreatedProjectReadinessTransfer(transfer);
      return options.isCurrent() && team.connection.readRoster().revision === receipt.revision &&
      team.owner.withLaunchAuthority(options.principalId, 'control', revision => revision) === actor; }
    catch { return false; }
  };
  const groups: ModelReadinessReference[] = [];
  const preparations: { profile: RuntimeMemberProfile; prepared: PreparedModelReadinessReference }[] = [];
  const targets: LaunchReadinessCaptureAdmission['targets'] = [];
  const expected = options.profiles.filter(row => row.provider === 'opencode');
  for (const profile of expected) {
    const destination = source.members.find(row => row.memberId === profile.memberId);
    if (!destination) held();
    let saved: Readonly<StoredModelProbe>;
    if (creating) {
      const probe = transfer.probes.find(row => row.memberName === destination.name);
      if (!probe) held();
      saved = options.management.probes.readRetainedProbe(probe.commandId, probe.context);
      if (saved.readinessScope?.kind !== 'create' ||
          saved.readinessScope.sourceRevision !== transfer.draftDigest ||
          saved.readinessScope.selectionDigest !== runtimeDigest(transfer.input) ||
          !saved.readinessScope.destinationKeys.includes(runtimeDigest(destination.name))) held();
      const intended = destination.role === 'lead' ? {}
        : transfer.input.draft.members.find(row => row.name === destination.name)?.memberSettings;
      if (!intended || runtimeDigest(intended) !== runtimeDigest(destination.settings) ||
          runtimeDigest(source.savedSettings) !== runtimeDigest(createdProjectSettings ?? transfer.input.draft.savedSettings)) held();
    } else {
      const logicalMemberId = project?.logicalMembers.find(row => row.name === destination.name && row.role === destination.role)?.memberId;
      if (project && !logicalMemberId) held();
      const intendedMemberId = logicalMemberId ?? destination.memberId;
      const matches = savedTransfer.probes.filter(({ selection }) => {
        const target = selection.draft?.target;
        return !target ? selection.memberId === intendedMemberId
          : target.kind === 'lead' ? destination.role === 'lead'
          : destination.role === 'member' && target.name === destination.name &&
            (selection.memberId === intendedMemberId ||
              !target.originalName && selection.memberId === `draft:${target.name}`);
      });
      if (matches.length !== 1) held();
      const original = matches[0]!, input = original.selection;
      if (input.draft && input.draft.providerId !== 'opencode') held();
      saved = options.management.probes.readScopedProbe(original.commandId, project?.logicalBindingDigest ?? teamBindingDigest, runtimeDigest(input));
      if (saved.readinessScope?.kind !== 'team' || saved.readinessScope.sourceRevision !== input.launchId ||
          saved.readinessScope.rosterRevision !== input.rosterRevision ||
          !saved.readinessScope.destinationKeys.includes(runtimeDigest(input.draft?.target ?? {
            launchId: input.launchId, memberId: input.memberId }))) held();
      if (input.draft && !input.launchId.startsWith('saved-model-') &&
          saved.readinessScope.actionDigest !== teamModelProbeActionDigest(original.commandId, saved.context!)) {
        if (saved.readinessScope.actionDigest !== teamModelProbeActionDigest(original.commandId, saved.context!,
          project?.probeRevision ?? transfer.roster.expected.expectedRevision)) held();
      } else if (input.rosterRevision !== (project?.probeRevision ?? transfer.roster.expected.expectedRevision)) held();
      if (input.draft?.target.kind === 'member') {
        const intended = transfer.roster.expected.members.find(row => row.name === destination.name);
        if (!intended) held();
        const { name: _name, ...settings } = intended;
        if (runtimeDigest(settings) !== runtimeDigest(destination.settings)) held();
      }
    }
    const prepared = await capturePreparedModelReference({ management: options.management, profile,
      commandId: saved.commandId, context: saved.context!, isCurrent: current });
    preparations.push({ profile, prepared });
    const { reference } = prepared;
    if (!groups.some(row => row.commandId === reference.commandId)) groups.push(reference);
    targets.push({ memberId: profile.memberId, originalProbeCommandId: saved.commandId,
      originalContext: saved.context!, originalWorkspace: saved.readinessScope!.workspace });
  }
  for (const { profile, prepared } of preparations)
    assertPreparedMemberModelReadiness({ management: options.management, profile, prepared, isCurrent: current });
  if (!targets.length || !current()) held();
  const cutoff = Math.min(creating ? transfer.cutoff : options.admittedAt + savedTransfer.remainingMs,
    ...groups.map(row => row.expiresAt));
  if (Date.now() >= cutoff) held();
  return { capture: {
    commandId: source.commandId, preparationId: creating ? transfer.input.preparationId : savedTransfer.preparationId,
    rosterCommandId: source.rosterCommandId, rosterRevision: source.configurationRevision,
    teamBindingDigest, actorDigest: runtimeDigest({ principalId: options.principalId, actor }),
    associationDigest: runtimeDigest(transfer), sourceDigest: runtimeDigest(source), admission: '',
    hostIncarnation: options.hostIncarnation, cutoff, phase: 'capturing', targets,
  }, groups };
}
