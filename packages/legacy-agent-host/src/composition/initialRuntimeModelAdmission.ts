import { z } from 'zod';

import { captureOpenCodeConfigurationSource } from '../adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { OpenCodeV2CredentialScope } from '../adapters/providers/OpenCodeV2CredentialScope.js';
import { managementDigest } from '../management/identity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { modelReadinessMechanismDigest } from '../team-launch/launchReadiness.js';
import { applyLaunchConfiguration, launchConfigurationSchema } from './launchConfiguration.js';
import { teamModelProbeProfile } from './teamLaunchModelProbe.js';

import type { ModelReadinessProbeScope } from '../management/commandRecords.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { MemberEntry } from './MemberEntry.js';
import type { OpenCodeMemberProfile } from './runtimeProfile.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { MemberActionInput } from '../team-launch/memberActions.js';
import type { capturePreparedModelReference } from './prepareTeamModelReadiness.js';

const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const binding = z.object({ backendId: id, teamId: id, runId: id, memberId: id, generation: id }).strict();
const probe = z.object({ commandId: id, profileId: id, configRevision: id, context: hash }).strict();
const actionSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('runtime.open'), teamId: id, commandId: id,
    payload: z.object({ memberId: id, expectedGeneration: id.optional() }).strict() }).strict(),
  z.object({ method: z.literal('team.launch.start'), teamId: id, commandId: id,
    payload: z.object({ configuration: z.lazy(() => launchConfigurationSchema).optional(),
      initialPrompt: z.string().min(1).max(100000)
        .refine(value => Boolean(value.trim()) && !value.includes('\0')).nullable().optional(),
    }).strict() }).strict(),
]);
const targetSchema = z.object({
  memberId: id, binding, recipeDigest: hash, sourceDigest: hash, accountDigest: hash,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('native-bootstrap') }).strict(),
    z.object({ kind: z.literal('native-local-readiness'), probe }).strict(),
  ]),
}).strict();

/** Private hashed-profile input only. No Runtime request or renderer selector accepts this shape. */
export const initialRuntimeModelAdmissionSchema = z.object({
  schemaVersion: z.literal(1), captureDigest: hash, ownerDigest: hash, principalId: id,
  teamDigest: hash, teamBindingDigest: hash, profileDigest: hash, action: actionSchema,
  targets: z.array(targetSchema).min(1).max(256),
}).strict().refine(value => {
  const { captureDigest, ...body } = value;
  return managementDigest(body) === captureDigest &&
    new Set(value.targets.map(target => target.memberId)).size === value.targets.length &&
    value.targets.every(target => target.memberId === target.binding.memberId &&
      target.binding.teamId === value.action.teamId) &&
    (value.action.method !== 'runtime.open' || value.targets.length === 1 &&
      value.targets[0]!.memberId === value.action.payload.memberId) &&
    Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024;
});
export type InitialRuntimeModelAdmission = z.infer<typeof initialRuntimeModelAdmissionSchema>;
export type InitialRuntimeModelProbeLocator = z.infer<typeof probe> & { memberId: string };
export type InitialRuntimeModelAction = z.infer<typeof actionSchema>;
export interface InitialRuntimeMemberAdmission {
  readonly admissions: readonly InitialRuntimeModelAdmission[];
}

function held(): never { throw new RuntimeOwnerError('hold'); }
const equal = (left: unknown, right: unknown) => managementDigest(left) === managementDigest(right);
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function capturedTeam(profile: TeamHostProfile, teamId: string) {
  const team = profile.teams.find(row => row.binding.teamId === teamId);
  if (!team || team.scope.teamId !== teamId || team.binding.backendId !== profile.owner.ownerId) held();
  return team;
}
function profileDigest(profile: TeamHostProfile, teamId: string): string {
  return managementDigest({ owner: profile.owner, principalId: profile.principalId,
    team: capturedTeam(profile, teamId),
    members: profile.runtime?.members.filter(member => member.teamId === teamId),
    providerTemplates: profile.runtime?.providerTemplates ?? null, management: profile.management ?? null });
}

/** Existing read-only source/account owners; a deferred manual file remains a descriptor, never a key proof. */
function captureSource(profile: OpenCodeMemberProfile, ownerCurrent: () => boolean) {
  const source = profile.nativeGeneration !== 'v2' || profile.embedded?.configurationSource
    ? captureOpenCodeConfigurationSource(profile, profile.embedded?.configurationSource, ownerCurrent) : undefined;
  const configuration = profile.nativeGeneration === 'v2'
    ? captureOpenCodeV2Configuration(profile, { providerId: profile.nativeOptions.providerId, modelId: profile.model },
      ownerCurrent, 'model', source ? { source, config: source.read() } : undefined) : undefined;
  const key = profile.nativeGeneration === 'v2' && !configuration?.selectedFile
    ? configuration?.key ?? new OpenCodeV2CredentialScope(profile, profile.nativeOptions.providerId, ownerCurrent).capture()
    : undefined;
  const facts = {
    sourceDigest: source?.digest ?? managementDigest(profile.embedded?.providerConfiguration ?? null),
    accountDigest: managementDigest({ binding: profile.accountBinding, providerId: profile.nativeOptions.providerId,
      home: profile.environment.HOME, data: profile.environment.XDG_DATA_HOME,
      key: key?.digest ?? null, deferred: configuration?.selectedFile?.descriptor.digest ?? null }),
  };
  const isCurrent = () => ownerCurrent() && (source?.isCurrent() ?? true) &&
    (configuration?.isCurrent() ?? true) && (key?.isCurrent() ?? true);
  if (!isCurrent()) held();
  return { ...facts, isCurrent };
}

/** Capture after the original recipe/management inputs are complete, before profile serialization/hash. */
export function captureInitialRuntimeModelAdmission(profile: TeamHostProfile,
  input: InitialRuntimeModelAction & { prepared?: readonly InitialRuntimeModelProbeLocator[] }): InitialRuntimeModelAdmission {
  const { prepared = [], ...rawAction } = input, action = actionSchema.parse(rawAction);
  const team = capturedTeam(profile, action.teamId), original = profileDigest(profile, action.teamId);
  const members = profile.runtime?.members.filter(member => member.teamId === action.teamId &&
    member.provider === 'opencode' && (action.method === 'runtime.open'
      ? member.memberId === action.payload.memberId
      : team.members.some(row => row.memberId === member.memberId && row.launchPolicy !== 'skip')));
  if (!members?.length || new Set(prepared.map(row => row.memberId)).size !== prepared.length ||
      prepared.some(row => !members.some(member => member.memberId === row.memberId))) held();
  const current = () => original === profileDigest(profile, action.teamId);
  const targets = members.map(member => {
    if (member.provider !== 'opencode') return held();
    const selected = team.members.find(row => row.memberId === member.memberId), delivery = selected?.delivery;
    if (!delivery || delivery.runId !== team.scope.runId || delivery.teamId !== team.binding.teamId ||
        delivery.backendId !== team.binding.backendId ||
        !team.grants.some(grant => grant.principalId === member.principalId && grant.memberName === selected?.name && !grant.revoked)) held();
    const observed = captureSource(member, current), selectedProbe = prepared.find(row => row.memberId === member.memberId);
    if (selectedProbe && !profile.management?.some(row => row.profileId === selectedProbe.profileId &&
        row.configRevision === selectedProbe.configRevision)) held();
    return { memberId: member.memberId, binding: normalizeBinding(delivery), recipeDigest: managementDigest(member),
      sourceDigest: observed.sourceDigest, accountDigest: observed.accountDigest,
      source: selectedProbe ? { kind: 'native-local-readiness' as const,
        probe: probe.parse(Object.fromEntries(Object.entries(selectedProbe).filter(([name]) => name !== 'memberId'))) }
        : { kind: 'native-bootstrap' as const } };
  });
  const body = { schemaVersion: 1 as const, ownerDigest: managementDigest(profile.owner),
    principalId: profile.principalId, teamDigest: managementDigest(team),
    teamBindingDigest: runtimeDigest({ backendId: team.binding.backendId, teamId: team.binding.teamId,
      teamName: team.binding.teamName }), profileDigest: original, action, targets };
  if (!current()) held();
  return immutable(initialRuntimeModelAdmissionSchema.parse({ ...body, captureDigest: managementDigest(body) }));
}

/** Pre-mutation constructor seed only. A selected entry retains provenance, never fresh initial authority. */
export function captureInitialRuntimeMemberAdmission(profile: TeamHostProfile,
  entry: MemberEntry): InitialRuntimeMemberAdmission | undefined {
  const originals = profile.runtime?.initialModelAdmissions ?? [];
  if (entry.profile.provider !== 'opencode' || entry.team.capture !== undefined ||
      entry.team.configurationRevision !== undefined) return undefined;
  const team = capturedTeam(profile, entry.binding.teamId);
  const seed = profile.runtime?.members.find(row => row.teamId === entry.binding.teamId && row.memberId === entry.profile.memberId);
  const delivery = team.members.find(row => row.memberId === entry.profile.memberId)?.delivery;
  if (!seed || seed.provider !== 'opencode' || !delivery || !equal(seed, entry.baseProfile) ||
      !equal(team.binding, entry.team.definition.binding) || !equal(team.scope, entry.team.definition.scope)) held();
  const effective = entry.selection?.configuration ? applyLaunchConfiguration(seed, entry.selection.configuration) : structuredClone(seed);
  if (entry.selection) {
    effective.generation = entry.selection.generation;
    if (entry.selection.baseConfigurationDigest !== runtimeDigest(seed) ||
        entry.selection.configurationDigest !== runtimeDigest(effective)) held();
  }
  if (!equal(effective, entry.profile) || !equal(entry.binding, entry.selection?.binding ?? normalizeBinding(delivery))) held();
  const admissions = originals.filter(raw => raw.action.teamId === entry.binding.teamId &&
    raw.targets.some(target => target.memberId === entry.profile.memberId)).map(raw => {
    const admission = initialRuntimeModelAdmissionSchema.parse(raw), target = admission.targets.find(row => row.memberId === entry.profile.memberId)!;
    if (admission.ownerDigest !== managementDigest(profile.owner) || admission.principalId !== profile.principalId ||
        admission.profileDigest !== profileDigest(profile, entry.binding.teamId) ||
        admission.teamDigest !== managementDigest(team) ||
        target.recipeDigest !== managementDigest(seed) || !equal(target.binding, normalizeBinding(delivery))) held();
    return admission;
  });
  return admissions.length ? immutable({ admissions: structuredClone(admissions) }) : undefined;
}

/** Same original Linux operation only; cutoff is supplied once immediately before its existing admission. */
export function initialRuntimeModelProbeScope(admission: InitialRuntimeModelAdmission,
  member: OpenCodeMemberProfile, cutoff: number): ModelReadinessProbeScope {
  const parsed = initialRuntimeModelAdmissionSchema.parse(admission), target = parsed.targets.find(row => row.memberId === member.memberId);
  if (!target || target.source.kind !== 'native-local-readiness' ||
      target.recipeDigest !== managementDigest(member)) held();
  const mechanism = teamModelProbeProfile(member);
  return { schemaVersion: 1, kind: 'native', teamBindingDigest: parsed.teamBindingDigest,
    actionDigest: managementDigest(parsed.action), selectionDigest: managementDigest(target),
    sourceRevision: parsed.captureDigest, rosterRevision: parsed.teamDigest,
    mechanismDigest: modelReadinessMechanismDigest(mechanism), workspace: member.cwd, cutoff,
    destinationKeys: [runtimeDigest({ launchId: target.binding.runId, memberId: target.memberId })] };
}

type InitialLaunch = Pick<TeamLaunchOwner, 'read' | 'readModelReadiness' | 'readModelReadinessSource' |
  'readModelReadinessAction' | 'attachModelReadiness' | 'retireModelReadiness'>;
type Management = Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;

function sourceFor(entry: MemberEntry, captureDigest: string, isCurrent: () => boolean) {
  const matches = entry.initialModelAdmission?.admissions.filter(row => row.captureDigest === captureDigest) ?? [];
  const admission = matches[0], target = admission?.targets.find(row => row.memberId === entry.profile.memberId);
  if (matches.length !== 1 || !admission || !target || entry.profile.provider !== 'opencode' ||
      entry.baseProfile.provider !== 'opencode' || entry.team.capture !== undefined ||
      entry.team.configurationRevision !== undefined || target.recipeDigest !== managementDigest(entry.baseProfile) ||
      !equal(entry.profile, { ...entry.baseProfile, generation: entry.profile.generation }) ||
      !equal({ ...entry.binding, generation: target.binding.generation }, target.binding)) held();
  const source = captureSource(entry.profile, isCurrent);
  if (source.sourceDigest !== target.sourceDigest || source.accountDigest !== target.accountDigest) held();
  return { admission, target, assertCurrent() {
    if (!isCurrent() || !source.isCurrent() || target.recipeDigest !== managementDigest(entry.baseProfile) ||
        !equal(entry.profile, { ...entry.baseProfile, generation: entry.profile.generation }) ||
        !equal({ ...entry.binding, generation: target.binding.generation }, target.binding)) held();
  } };
}

/** Existing command entrypoint only, before its first await. No missing-profile or missing-proof fallback. */
export function attachInitialRuntimeModelAdmission(options: {
  launch: InitialLaunch; entries: readonly MemberEntry[]; method: InitialRuntimeModelAction['method'];
  teamId: string; commandId: string; payload: unknown; actorDigest: string; hostIncarnation: string;
  management?: Management; captureReference?: typeof capturePreparedModelReference; assertCurrent(): void;
}): void {
  options.assertCurrent();
  const summary = options.launch.read();
  let payload = options.payload;
  if (options.method === 'team.launch.start') {
    const raw = z.object({ launchId: id, rosterRevision: id, configuration: launchConfigurationSchema.optional(),
      initialPrompt: z.string().nullable().optional() }).strict().parse(payload);
    if (raw.launchId !== summary.launchId || raw.rosterRevision !== summary.rosterRevision) held();
    const { launchId: _launchId, rosterRevision: _revision, ...intent } = raw;
    payload = intent;
  }
  const action = actionSchema.parse({ method: options.method, teamId: options.teamId, commandId: options.commandId, payload });
  const matches = options.entries[0]?.initialModelAdmission?.admissions.filter(row => equal(row.action, action)) ?? [];
  const admission = matches[0];
  if (matches.length !== 1 || !admission || !options.entries.length ||
      !equal(admission.targets.map(row => row.memberId).sort(), options.entries.map(row => row.profile.memberId).sort())) held();
  const isCurrent = () => { try { options.assertCurrent(); return true; } catch { return false; } };
  const captured = options.entries.map(entry => {
    const observed = sourceFor(entry, admission.captureDigest, isCurrent);
    const member = summary.members.find(row => row.memberId === entry.profile.memberId);
    const initialAttempt = `initial-${runtimeDigest({ launchId: summary.launchId, memberId: entry.profile.memberId })}`;
    if (entry.selection || !equal(entry.profile, entry.baseProfile) || !equal(entry.binding, observed.target.binding) ||
        !member || !equal(member.binding, entry.binding) || member.attempt.claimed || member.attempt.status === 'skipped' ||
        member.attempt.attemptId !== initialAttempt || member.attempt.hostIncarnation !== options.hostIncarnation ||
        member.attempt.startedAtMs !== 0 || member.attempt.deadlineMs !== 0) held();
    const configured = action.method === 'team.launch.start'
      ? action.payload.configuration?.members.find(row => row.memberId === entry.profile.memberId) : undefined;
    if (configured && !equal(applyLaunchConfiguration(entry.baseProfile,
      Object.fromEntries(Object.entries(configured).filter(([name]) => name !== 'memberId'))), entry.profile)) held();
    const reference = (() => {
      if (observed.target.source.kind === 'native-bootstrap') return undefined;
      const locator = observed.target.source.probe, management = options.management;
      if (!management || !options.captureReference || entry.profile.provider !== 'opencode') return held();
      const original = management.probes.readRetainedProbe(locator.commandId, locator.context);
      if (original.profileId !== locator.profileId || original.configRevision !== locator.configRevision ||
          !original.readinessScope || !equal(original.readinessScope,
            initialRuntimeModelProbeScope(admission, entry.profile, original.readinessScope.cutoff))) held();
      return options.captureReference({ management, profile: entry.profile, commandId: locator.commandId,
        context: locator.context, kind: 'native', isCurrent });
    })();
    return { entry, observed, reference, initialAttempt };
  });
  for (const row of captured) row.observed.assertCurrent();
  for (const { entry, reference, initialAttempt } of captured) {
    const consumer = {
      memberId: entry.profile.memberId, actionId: options.commandId, actorDigest: options.actorDigest,
      inputDigest: managementDigest(options.payload), binding: entry.binding,
      baseConfigurationDigest: runtimeDigest(entry.baseProfile), configurationDigest: runtimeDigest(entry.profile),
      configRevision: entry.profile.configRevision,
    };
    options.launch.attachModelReadiness(reference ? { reference, initialAttemptId: initialAttempt, consumer: { ...consumer,
      cutoff: reference.expiresAt, groupCommandId: reference.commandId } } : { initialAttemptId: initialAttempt, consumer: {
      ...consumer, initialProfile: { kind: 'native-bootstrap',
        captureDigest: admission.captureDigest, commandId: admission.action.commandId, actionDigest: managementDigest(admission.action) },
    } });
  }
  options.assertCurrent();
}

/** Source provenance is not execution proof; actual launch-claim time and provider allocation remain original. */
export function inspectInitialRuntimeModelAdmission(options: {
  launch: Pick<InitialLaunch, 'readModelReadiness'>; entry: MemberEntry; assertCurrent(): void;
  hostIncarnation?: string; phase: 'preclaim' | 'allocation' | 'source';
}) {
  const { entry, launch } = options;
  const selected = { binding: structuredClone(entry.binding), configRevision: entry.profile.configRevision,
    configurationDigest: runtimeDigest(entry.profile) };
  const original = launch.readModelReadiness(selected), root = original.consumer.initialProfile;
  if (!root || original.reference) held();
  const isCurrent = () => { try { options.assertCurrent(); return true; } catch { return false; } };
  const source = sourceFor(entry, root.captureDigest, isCurrent);
  if (source.target.source.kind !== 'native-bootstrap' || source.admission.action.commandId !== root.commandId ||
      managementDigest(source.admission.action) !== root.actionDigest) held();
  const current = () => {
    options.assertCurrent();
    source.assertCurrent();
    const { consumer, attempt } = launch.readModelReadiness(selected);
    if (consumer.consumerId !== original.consumer.consumerId ||
        consumer.baseConfigurationDigest !== runtimeDigest(entry.baseProfile) ||
        attempt.attemptId !== consumer.sourceAttemptId) held();
    if (options.phase === 'source') {
      if (consumer.disposition !== 'consumed' || !attempt.claimed || attempt.noAllocation) held();
    } else if (options.phase === 'allocation') {
      if (!options.hostIncarnation || attempt.hostIncarnation !== options.hostIncarnation || !attempt.claimed ||
          attempt.noAllocation || attempt.startedAtMs <= 0 || attempt.deadlineMs <= attempt.startedAtMs ||
          Date.now() >= attempt.deadlineMs) held();
    } else if (!attempt.claimed && (!options.hostIncarnation || attempt.hostIncarnation !== options.hostIncarnation ||
        attempt.startedAtMs !== 0 || attempt.deadlineMs !== 0 || consumer.disposition !== 'pending')) held();
    // A claimed precheck creates nothing: the original retry owner still proves current noAllocation before its transition.
  };
  current();
  return { assertCurrent: current, consumerId: original.consumer.consumerId, kind: 'initial' as const };
}

/** Only the already captured native action may carry an ordinary initial source to its exact successor. */
export function captureInitialRuntimeRestart(options: {
  launch: InitialLaunch; entry: MemberEntry; input: MemberActionInput; actorDigest: string;
  profile: OpenCodeMemberProfile; binding: RuntimeBinding; assertCurrent(): void;
  authorized: <T>(operation: () => T) => T;
}) {
  const { entry, launch } = options;
  const selected = { binding: structuredClone(entry.binding), configRevision: entry.profile.configRevision,
    configurationDigest: runtimeDigest(entry.profile) };
  const original = launch.readModelReadinessSource(selected);
  if (!original?.consumer.initialProfile) return undefined;
  inspectInitialRuntimeModelAdmission({ launch, entry, assertCurrent: options.assertCurrent, phase: 'source' });
  const root = structuredClone(original.consumer.initialProfile);
  const current = () => {
    options.assertCurrent();
    const retained = launch.readModelReadinessSource(selected)?.consumer;
    if (!retained || retained.consumerId !== original.consumer.consumerId ||
        retained.disposition !== 'retired') held();
  };
  // The old generation must no longer qualify allocation while its original native action closes it.
  launch.retireModelReadiness(entry.profile.memberId);
  current();
  const originalBase = runtimeDigest(entry.baseProfile), profile = structuredClone(options.profile), binding = structuredClone(options.binding);
  return { attach() {
    if (!equal(entry.profile, profile) || !equal(entry.binding, binding) ||
        originalBase !== runtimeDigest(entry.baseProfile) || !entry.selection ||
        options.input.action !== 'restart' || options.input.memberId !== entry.profile.memberId) held();
    const check = () => options.authorized(() => undefined);
    sourceFor(entry, root.captureDigest, () => { try { check(); return true; } catch { return false; } }).assertCurrent();
    const { commandId: _commandId, ...input } = options.input;
    launch.attachModelReadiness({ consumer: {
      memberId: entry.profile.memberId, actionId: options.input.commandId, actorDigest: options.actorDigest,
      inputDigest: managementDigest(input), binding: entry.binding, baseConfigurationDigest: originalBase,
      configurationDigest: runtimeDigest(entry.profile), configRevision: entry.profile.configRevision,
      initialProfile: { ...root, predecessorConsumerId: original.consumer.consumerId },
    } }, options.authorized);
  } };
}
