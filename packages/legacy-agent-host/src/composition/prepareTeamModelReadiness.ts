import { z } from 'zod';
import { replaceRosterPayloadSchema } from '../team/rosterSchema.js';
import { teamModelProbeSelectionSchema } from './teamLaunchModelProbe.js';
import { teamModelProbeProfile, teamModelProbeEffort, teamModelProbeActionDigest } from './teamLaunchModelProbe.js';
import { actualCaptureReadinessCommandId, modelReadinessMechanismDigest } from '../team-launch/launchReadiness.js';
import { captureOpenCodeConfigurationSource } from '../adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeReadinessOrigin, captureReadinessPreparation,
  originalReadinessSubset } from '../adapters/providers/OpenCodeReadinessOrigin.js';
import { captureOpenCodeV2Configuration } from '../adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { OpenCodeV2CredentialScope } from '../adapters/providers/OpenCodeV2CredentialScope.js';
import { AcceptedOpenCodeV2FileKey } from '../adapters/providers/OpenCodeV2SelectedFileKey.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { nativeLocalReadinessPurpose } from '../management/ModelProbeOwner.js';
import { managementDigest } from '../management/identity.js';
import { runtimeDigest } from '../runtime/identity.js';
import { inspectInitialRuntimeModelAdmission } from './initialRuntimeModelAdmission.js';

import type { ModelProbeInput } from '../management/ModelProbeOwner.js';
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

const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));

/** Main resolves these exact retained intents; Host validates every receipt and publication join. */
export const localModelReadinessTransferSchema = z.object({
  preparationId: id,
  remainingMs: z.number().int().min(1).max(100000),
  probes: z.array(z.object({ commandId: id, selection: teamModelProbeSelectionSchema }).strict())
    .min(1).max(256),
  roster: z.object({ commandId: id, expected: replaceRosterPayloadSchema }).strict(),
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
export type CaptureModelReadinessTransfer = LocalModelReadinessTransfer | CreationModelReadinessTransfer;
export type LocalModelReadinessAction = {
  preparation: LocalModelReadinessPreparation; owner: unknown; handleId: string; scope: unknown;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function held(): never { throw new ManagementCommandError('held'); }

function openCodeModelId(providerId: string, modelId: string): string {
  return modelId.startsWith(providerId + '/') ? modelId.slice(providerId.length + 1) : modelId;
}

/** The original URL classifier's loopback branch only; no DNS, metadata or network observation. */
function loopback(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return false;
  let hostname = url.hostname.toLowerCase().replace(/(?:^\[|\]$)/g, '');
  if (hostname.includes(':')) {
    const mapped = /^\[::ffff:([a-f0-9]+):([a-f0-9]+)\]$/.exec(new URL('https://[' + hostname + ']').hostname);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16);
      hostname = [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
    }
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)?.slice(1).map(Number);
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' ||
    !!octets?.every(value => value <= 255) && octets[0] === 127;
}

/** Existing private configuration/key readers only. No native allocation or inference. */
export function captureOpenCodeProbeAccount(
  profile: OpenCodeManagementProfile,
  input: Pick<ModelProbeInput, 'providerId' | 'modelId'>,
  ownerCurrent: () => boolean,
  original?: Readonly<StoredModelProbe>,
  capturedOrigin = original?.localModelReadinessOrigin
): { digest: string; isCurrent(): boolean; nativeCredentialScopeDigest?: string } | undefined {
  return captureOpenCodeProbeAccountInspection(profile, input, ownerCurrent, original, capturedOrigin)?.account;
}

/** The same synchronous account inspection also owns its freshly captured policy inspector. */
function captureOpenCodeProbeAccountInspection(
  profile: OpenCodeManagementProfile,
  input: Pick<ModelProbeInput, 'providerId' | 'modelId'>,
  ownerCurrent: () => boolean,
  original?: Readonly<StoredModelProbe>,
  capturedOrigin = original?.localModelReadinessOrigin
): {
  account: NonNullable<ReturnType<typeof captureOpenCodeProbeAccount>>;
  origin: ReturnType<typeof captureOpenCodeReadinessOrigin> | undefined;
} | undefined {
  const source = captureOpenCodeConfigurationSource(profile,
    profile.nativeGeneration === 'v2' ? profile.embedded?.configurationSource : undefined, ownerCurrent);
  const policy = capturedOrigin
    ? captureOpenCodeReadinessOrigin(capturedOrigin, profile, input.providerId, ownerCurrent) : undefined;
  const raw = source.read(), provider = object(raw.provider) ? raw.provider[input.providerId] : undefined;
  const options = object(provider) && object(provider.options) ? provider.options : {};
  const resolve = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    if (value.includes('{file:')) return held();
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
      (_match: string, braced: string | undefined, shell: string | undefined) => {
        const selected = profile.environment[braced ?? shell!];
        if (selected === undefined || selected.includes('\0')) return held();
        return selected;
      });
  };
  const configuredKey = (policy || profile.nativeGeneration === 'v2') &&
    typeof options.apiKey === 'string' && options.apiKey.includes('{file:') ? options.apiKey : resolve(options.apiKey);
  const selectedUrl = policy ? policy.policy?.baseUrl
    : object(provider) && provider.npm === '@ai-sdk/openai-compatible' ? resolve(options.baseURL) : undefined;
  const configured = policy?.policy?.hasConfiguredApiKey ??
    (typeof configuredKey === 'string' && Boolean(configuredKey.trim()));
  const modelId = openCodeModelId(input.providerId, input.modelId);
  const configuration = profile.nativeGeneration === 'v2' && profile.embedded?.configurationSource
    ? captureOpenCodeV2Configuration(profile, { providerId: input.providerId, modelId }, ownerCurrent,
      'model', { source, config: raw }) : undefined;
  const key = !configuration?.selectedFile && (profile.nativeGeneration === 'v2' || loopback(selectedUrl) && !configured)
    ? configuration?.key ?? new OpenCodeV2CredentialScope(profile, input.providerId, source.isCurrent).capture()
    : undefined;
  let fileProof: AcceptedOpenCodeV2FileKey | undefined;
  const current = () => {
    try { return ownerCurrent() && source.isCurrent() && (configuration?.isCurrent() ?? true) &&
      (key?.isCurrent() ?? true) && (fileProof?.filesCurrent() ?? true) && (policy?.isCurrent() ?? true); } catch { return false; }
  };
  if (!current()) held();
  if (configuration?.selectedFile) {
    // Initial scope commits the original source/selection but cannot invent its future native key.
    if (!original) return undefined;
    const assertOriginal = () => {
      if (!current() || original.phase !== 'completed' || !original.ok || original.resourceHeld ||
          !original.context || original.profileId !== profile.profileId || original.configRevision !== profile.configRevision ||
          original.providerId !== input.providerId ||
          (original.modelId !== input.modelId && `${input.providerId}/${original.modelId}` !== input.modelId) ||
          (original.purpose === undefined ? original.readinessScope?.kind !== 'native' :
            original.purpose !== nativeLocalReadinessPurpose || !original.readiness || original.readiness.context !== original.context ||
            original.readiness.selectionDigest !== original.selectionDigest ||
            original.readiness.evidence.ordinary !== 'confirmed' || original.readiness.evidence.decision !== 'allow')) held();
    };
    assertOriginal();
    if (!original.nativeFileKeyWitness) held();
    fileProof = AcceptedOpenCodeV2FileKey.retained(configuration.selectedFile, original.nativeFileKeyWitness, assertOriginal);
  }
  if (original?.nativeFileKeyWitness !== undefined && !fileProof) held();
  const nativeCredentialScopeDigest = fileProof?.scopeDigest ?? (key?.present ? key.digest : undefined);
  const account = {
    digest: managementDigest({ binding: profile.accountBinding, key: fileProof?.scopeDigest ?? key?.digest ?? null,
      configuredKey: typeof configuredKey === 'string' ? configuredKey : null }),
    isCurrent: current,
    ...(profile.nativeGeneration === 'v2' && nativeCredentialScopeDigest !== undefined ? { nativeCredentialScopeDigest } : {}),
  };
  return { account, origin: policy };
}

/** Caller already validated its exact product publication; this never admits a replacement profile. */
export function capturePreparedModelReference(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  profile: RuntimeMemberProfile;
  commandId: string;
  context: string;
  kind?: 'native';
  isCurrent(): boolean;
  observeAccount?(account: ReturnType<typeof captureOpenCodeProbeAccount>): void;
}): ModelReadinessReference {
  const original = options.management.probes.readRetainedProbe(options.commandId, options.context);
  const candidate = { ...teamModelProbeProfile(options.profile),
    profileId: original.profileId, configRevision: original.configRevision };
  if (candidate.provider !== 'opencode' || options.profile.provider !== 'opencode' || !options.isCurrent() ||
      original.providerId !== options.profile.nativeOptions.providerId ||
      openCodeModelId(original.providerId, original.modelId) !==
        openCodeModelId(original.providerId, options.profile.model) ||
      original.effort !== options.profile.nativeOptions.variant ||
      (options.kind !== 'native' && original.purpose !== nativeLocalReadinessPurpose) ||
      (original.purpose === undefined && original.readinessScope?.kind !== 'native') ||
      modelReadinessMechanismDigest(candidate) !== original.readinessScope?.mechanismDigest) held();
  return options.management.probes.captureReadinessReference(options.commandId, options.context, saved => {
    const inspected = saved.readiness || saved.readinessScope?.accountDigest !== undefined || saved.nativeFileKeyWitness !== undefined
      ? captureOpenCodeProbeAccountInspection(candidate, saved, options.isCurrent, saved) : undefined;
    const account = inspected?.account;
    const origin = inspected?.origin ?? (saved.localModelReadinessOrigin
      ? captureOpenCodeReadinessOrigin(saved.localModelReadinessOrigin, candidate, saved.providerId,
        options.isCurrent) : undefined);
    if (!options.isCurrent() || account && !account.isCurrent() || saved.nativeFileKeyWitness !== undefined && !account) held();
    options.observeAccount?.(account);
    return { target: options.management.readinessTarget(candidate),
      originCurrent: (!origin || origin.isCurrent()) && options.isCurrent(),
      ...(account ? { accountDigest: account.digest } : {}) };
  });
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
}): Promise<void> {
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
  const prepared: { entry: MemberEntry; reference: ModelReadinessReference }[] = [];
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
    const reference = capturePreparedModelReference({ management: options.management, profile: entry.profile,
      commandId, context: original.context!, isCurrent: current });
    if (!changed && runtimeDigest(options.launch.readModelReadinessGroup(commandId) ?? null) !== runtimeDigest(reference)) held();
    prepared.push({ entry, reference });
  }
  if (!current()) held();
  for (const { entry, reference } of prepared) attachMemberModelReadiness({ ...options, entry, reference,
    actorDigest: runtimeDigest(entry.team.owner.withLaunchAuthority(options.principalId, 'control', revision =>
      ({ principalId: options.principalId, revision }))), inputDigest: runtimeDigest(options.payload), cutoff: capture.cutoff });
}

/** Synchronous allocation check; no preparation/native effects are allowed at this boundary. */
export function inspectMemberModelReadiness(options: {
  management?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  launch: TeamLaunchOwner; entry: MemberEntry; assertCurrent(): void;
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
  const current = () => {
    options.assertCurrent();
    const current = launch.readModelReadiness(selected), consumer = current.consumer;
    if (consumer.consumerId !== original.consumer.consumerId ||
        consumer.baseConfigurationDigest !== runtimeDigest(entry.baseProfile)) held();
    if (consumer.continuation) {
      const restore = entry.selection?.restore;
      if (!restore || restore.reference !== consumer.continuation.reference ||
          runtimeDigest(restore.sourceBinding) !== runtimeDigest(consumer.continuation.sourceBinding)) held();
      return;
    }
    if (!options.management || !current.reference || consumer.cutoff === undefined || Date.now() >= consumer.cutoff) held();
    const observed = capturePreparedModelReference({ management: options.management, profile: entry.profile,
      commandId: current.reference.commandId, context: current.reference.context,
      ...(current.reference.purpose === 'ordinary' ? { kind: 'native' as const } : {}),
      observeAccount: value => { if (value) observedAccount.value = value; else delete observedAccount.value; },
      isCurrent: () => { try { options.assertCurrent(); return true; } catch { return false; } } });
    if (runtimeDigest(observed) !== runtimeDigest(current.reference)) held();
    options.assertCurrent();
  };
  current();
  return { assertCurrent: current, consumerId: original.consumer.consumerId,
    kind: original.consumer.continuation ? 'continuation' : 'preparation',
    ...(original.reference ? { reference: original.reference } : {}),
    ...(!original.consumer.continuation && observedAccount.value?.nativeCredentialScopeDigest !== undefined ? {
      assertReadinessCredential(scopeDigest: string) {
        current();
        const account = observedAccount.value;
        if (!account || !account.isCurrent() || account.nativeCredentialScopeDigest !== scopeDigest) held();
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
export function captureNativeRestartReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  launch: Pick<TeamLaunchOwner, 'readModelReadinessSource'>; entry: MemberEntry; isCurrent(): boolean;
}) {
  const { entry, management } = options;
  const source = options.launch.readModelReadinessSource({ binding: entry.binding,
    configRevision: entry.profile.configRevision, configurationDigest: runtimeDigest(entry.profile) });
  if (!source?.reference || source.consumer.baseConfigurationDigest !== runtimeDigest(entry.baseProfile)) held();
  const reference = source.reference;
  const profile = { ...teamModelProbeProfile(entry.profile),
    profileId: reference.profileId, configRevision: reference.configRevision };
  if (profile.provider !== 'opencode' || entry.profile.provider !== 'opencode' ||
      modelReadinessMechanismDigest(profile) !== reference.mechanismDigest) held();
  const providerId = entry.profile.nativeOptions.providerId, model = entry.profile.model;
  const read = () => management.probes.readReadinessProvenance(reference, saved => {
    if (!options.isCurrent() || saved.providerId !== providerId ||
        openCodeModelId(providerId, saved.modelId) !== openCodeModelId(providerId, model) ||
        saved.effort !== profile.variant) held();
    const policy = saved.localModelReadinessOrigin
      ? captureOpenCodeReadinessOrigin(saved.localModelReadinessOrigin, profile, providerId, options.isCurrent)
      : undefined;
    const account = saved.readiness || saved.readinessScope?.accountDigest !== undefined || saved.nativeFileKeyWitness !== undefined
      ? captureOpenCodeProbeAccount(profile, saved, options.isCurrent, saved) : undefined;
    if (saved.nativeFileKeyWitness !== undefined && !account) held();
    return { target: management.readinessTarget(profile),
      originCurrent: options.isCurrent() && (policy?.isCurrent() ?? true) && (account?.isCurrent() ?? true),
      ...(account ? { accountDigest: account.digest } : {}) };
  });
  const original = read();
  return { reference, original, assertCurrent: () => { read(); } };
}

/** One explicit action attachment in the existing launch record, before Stop or workspace awaits. */
export function captureActionModelReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget' | 'admitTeamProbeProfile'>;
  launch: Pick<TeamLaunchOwner, 'attachModelReadiness' | 'readModelReadinessAction'>;
  targets: readonly { entry: MemberEntry; profile: RuntimeMemberProfile; binding: RuntimeBinding }[];
  commandId: string; payload: unknown; actorDigest: string; readiness?: LocalModelReadinessAction;
  nativeSource?: ReturnType<typeof captureNativeRestartReadiness>;
  authorized?: <T>(operation: () => T) => T;
  assertCurrent(): void;
}) {
  const admittedAt = Date.now(), payload = structuredClone(options.payload), inputDigest = runtimeDigest(payload);
  const targets = options.targets.filter(row => row.profile.provider === 'opencode');
  if (!targets.length || targets.length > 256 || options.readiness && options.nativeSource) held();
  options.assertCurrent();
  const captured = targets.map(row => ({ ...row, profile: structuredClone(row.profile),
    binding: structuredClone(row.binding), sourceBinding: structuredClone(row.entry.binding),
    sourceProfile: runtimeDigest(row.entry.profile) }));
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
    const references = new Map<string, ModelReadinessReference>();
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
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget' | 'admitTeamProbeProfile'>;
  profile: RuntimeMemberProfile;
  commandId: string;
  context: string;
  cutoff: number;
  scope: ModelReadinessProbeScope;
  prepared?: { anchor: ReadinessPreparationAnchor; origin?: LocalModelReadinessOrigin };
  isCurrent(): boolean;
}): Promise<ModelReadinessReference> {
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
  options.management.probes.startPrepared(input, current, options.prepared, scope);
  await options.management.probes.awaitPrepared(input.commandId, input.context);
  if (!current()) held();
  return capturePreparedModelReference({ ...options,
    ...(options.scope.kind === 'native' ? { kind: 'native' as const } : {}), isCurrent: current });
}

/** Exact original publication bridge; the old pre-CAS roster callback is deliberately not re-run. */
export function captureLaunchModelReadiness(options: {
  management: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  team: HostedTeam; source: RuntimeCaptureSource; profiles: RuntimeMemberProfile[];
  principalId: string; hostIncarnation: string; transfer: CaptureModelReadinessTransfer;
  admittedAt: number; isCurrent(): boolean;
}): { capture: LaunchReadinessCaptureAdmission; groups: ModelReadinessReference[] } {
  const { team, source, transfer } = options;
  const creating = 'kind' in transfer;
  if (!creating) localModelReadinessTransferSchema.parse(transfer);
  const teamBindingDigest = runtimeDigest(team.definition.binding);
  const actor = team.owner.withLaunchAuthority(options.principalId, 'control', revision => revision);
  const receipt = team.connection.lookupRoster(transfer.roster.commandId, transfer.roster.expected);
  if (!receipt || transfer.roster.commandId !== source.rosterCommandId ||
      receipt.revision !== source.configurationRevision ||
      team.connection.readRoster().revision !== receipt.revision) held();
  const current = () => {
    try { return options.isCurrent() && team.connection.readRoster().revision === receipt.revision &&
      team.owner.withLaunchAuthority(options.principalId, 'control', revision => revision) === actor; }
    catch { return false; }
  };
  const groups: ModelReadinessReference[] = [];
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
          runtimeDigest(source.savedSettings) !== runtimeDigest(transfer.input.draft.savedSettings)) held();
    } else {
      const matches = transfer.probes.filter(({ selection }) => {
        const target = selection.draft?.target;
        return !target ? selection.memberId === destination.memberId
          : target.kind === 'lead' ? destination.role === 'lead'
          : destination.role === 'member' && target.name === destination.name &&
            (selection.memberId === destination.memberId ||
              !target.originalName && selection.memberId === `draft:${target.name}`);
      });
      if (matches.length !== 1) held();
      const original = matches[0]!, input = original.selection;
      if (input.draft && input.draft.providerId !== 'opencode') held();
      saved = options.management.probes.readScopedProbe(original.commandId, teamBindingDigest, runtimeDigest(input));
      if (saved.readinessScope?.kind !== 'team' || saved.readinessScope.sourceRevision !== input.launchId ||
          saved.readinessScope.rosterRevision !== input.rosterRevision ||
          !saved.readinessScope.destinationKeys.includes(runtimeDigest(input.draft?.target ?? {
            launchId: input.launchId, memberId: input.memberId }))) held();
      if (input.draft && !input.launchId.startsWith('saved-model-') &&
          saved.readinessScope.actionDigest !== teamModelProbeActionDigest(original.commandId, saved.context!)) {
        if (saved.readinessScope.actionDigest !== teamModelProbeActionDigest(original.commandId, saved.context!,
          transfer.roster.expected.expectedRevision)) held();
      } else if (input.rosterRevision !== transfer.roster.expected.expectedRevision) held();
      if (input.draft?.target.kind === 'member') {
        const intended = transfer.roster.expected.members.find(row => row.name === destination.name);
        if (!intended) held();
        const { name: _name, ...settings } = intended;
        if (runtimeDigest(settings) !== runtimeDigest(destination.settings)) held();
      }
    }
    const reference = capturePreparedModelReference({ management: options.management, profile,
      commandId: saved.commandId, context: saved.context!, isCurrent: current });
    if (!groups.some(row => row.commandId === reference.commandId)) groups.push(reference);
    targets.push({ memberId: profile.memberId, originalProbeCommandId: saved.commandId,
      originalContext: saved.context!, originalWorkspace: saved.readinessScope!.workspace });
  }
  if (!targets.length || !current()) held();
  const cutoff = Math.min(creating ? transfer.cutoff : options.admittedAt + transfer.remainingMs,
    ...groups.map(row => row.expiresAt));
  if (Date.now() >= cutoff) held();
  return { capture: {
    commandId: source.commandId, preparationId: creating ? transfer.input.preparationId : transfer.preparationId,
    rosterCommandId: source.rosterCommandId, rosterRevision: source.configurationRevision,
    teamBindingDigest, actorDigest: runtimeDigest({ principalId: options.principalId, actor }),
    associationDigest: runtimeDigest(transfer), sourceDigest: runtimeDigest(source), admission: '',
    hostIncarnation: options.hostIncarnation, cutoff, phase: 'capturing', targets,
  }, groups };
}
