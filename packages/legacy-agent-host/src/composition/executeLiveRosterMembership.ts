import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { replaceRosterPayloadSchema, replaceRosterSchema } from '../team/rosterSchema.js';
import { parseLiveRosterPrivateInput, parseLiveRosterResponse } from '../team/liveRosterMembership.js';
import { runtimeDigest } from '../runtime/identity.js';
import { modelReadinessMechanismDigest } from '../team-launch/launchReadiness.js';
import { captureReadinessPreparation, originalReadinessSubset } from '../adapters/providers/OpenCodeReadinessOrigin.js';
import { capturedMcpSourceCurrent } from '../mcp-catalog/capturedSource.js';
import { captureLiveRosterMember, liveRosterTargetTeam } from './captureLiveRosterMember.js';
import { assertCapturedRosterCurrent } from './teamRoster.js';
import { createMemberEntry } from './createMemberEntry.js';
import { runtimeCaptureSourceSchema } from './runtimeCaptureSource.js';
import { teamModelProbeProfile } from './teamLaunchModelProbe.js';
import { captureLiveRosterProcessOrigin } from './captureRuntimeProcessOrigin.js';
import { closeRuntimeMember } from './transitionRuntimeMember.js';
import { attachMemberModelReadiness, prepareTeamModelReadiness } from './prepareTeamModelReadiness.js';
import { envelopeSchema } from './teamHostEnvelope.js';
import { z } from 'zod';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamMember, TeamOwnerErrorCode } from '../team/contracts.js';
import type { TeamLiveRosterMembership, LiveRosterOriginal, LiveRosterPrivateInput,
  LiveRosterResponse, LiveRosterReceipt, LiveRosterPreview } from '../team/liveRosterMembership.js';
import type { ExpectedLaunchMember } from '../team-launch/contracts.js';
import type { createLiveRosterLaunch, LiveLaunchIntent } from '../team-launch/liveRosterMembership.js';
import type { LocalModelReadinessPreparation, ModelReadinessReference } from '../management/commandRecords.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import type { RetainedNativeLaunch } from './createRuntimeNativeMemberCreation.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';

export interface LiveRosterOperation {
  teamId: string;
  method: 'team.roster.replace' | 'team.roster.lookup';
  commandId: string;
  payload: unknown;
  binding: z.infer<typeof envelopeSchema>['binding'];
  conversation: LiveRosterPrivateInput;
  localModelReadinessOrigin?: LocalModelReadinessPreparation;
}
export interface LiveRosterExecutionOptions {
  profile: TeamHostProfile;
  sources?: RuntimeRecipeSources;
  teams: ReadonlyMap<string, HostedTeam>;
  capturedTeams: ReadonlyMap<string, HostedTeam>;
  retainedLaunches: ReadonlyMap<string, RetainedNativeLaunch>;
  entries: Map<string, MemberEntry>;
  runtime: RuntimeOwner;
  hostIncarnation: string;
  modelReadiness?: Pick<ProviderManagementCoordinator,
    'probes' | 'readinessTarget' | 'admitTeamProbeProfile'>;
  assertCurrent(teamId: string): void;
  assertRosterEditable(teamId: string, members: readonly TeamMember[]): void;
  trackOpening<T>(pending: Promise<T>): Promise<T>;
  onProgress(): void;
}

type Captured = Awaited<ReturnType<typeof captureLiveRosterMember>>;
type Launch = ReturnType<typeof createLiveRosterLaunch>;
interface Target {
  entry: MemberEntry;
  binding: MemberEntry['binding'];
  retained: RetainedNativeLaunch;
  expected: ExpectedLaunchMember;
  claimed: boolean;
  provider: MemberEntry['provider'];
  endpoint: MemberEntry['endpoint'];
}
interface Flight {
  input: LiveRosterOperation;
  requestDigest: string;
  bindingDigest: string;
  team: HostedTeam;
  retained: RetainedNativeLaunch;
  lead?: MemberEntry;
  owner: TeamLiveRosterMembership;
  original: LiveRosterOriginal;
  receipt: LiveRosterReceipt;
  launch: Launch;
  targets: Target[];
  intent: LiveLaunchIntent;
  cutoff: number;
  continuation: boolean;
  openingInvoked: boolean;
  captured?: Captured;
  entry?: MemberEntry;
  probe?: { commandId: string; context: string };
  reference?: ModelReadinessReference;
  closed: Map<string, Promise<boolean>>;
  readinessCleanup: Map<string, Promise<void>>;
}
// A retained receipt never recreates this first-call authority, in this Host or a replacement Host.
const flights = new WeakMap<RuntimeOwner, Map<string, Flight>>();
const held = (): never => { throw new TeamOwnerError('hold'); };
const equal = (a: unknown, b: unknown) => runtimeDigest(a ?? null) === runtimeDigest(b ?? null);
const key = (teamId: string, commandId: string) => runtimeDigest({ teamId, commandId });
const runId = (team: HostedTeam) => team.launchId ?? team.definition.scope.runId;
const code = (error: unknown): TeamOwnerErrorCode => error instanceof TeamOwnerError
  ? error.code : 'hold';

function assertFlight(options: LiveRosterExecutionOptions, flight: Flight, fresh = false, checkCapture = true): void {
  flight.owner.withOriginal(flight.original, () => {});
  if (fresh) {
    if (Date.now() >= flight.cutoff || !flight.lead ||
        options.capturedTeams.get(flight.input.teamId) !== flight.retained.team ||
        !capturedMcpSourceCurrent(flight.lead.profile)) return held();
    flight.team.owner.assertExecutionAllowed(options.profile.principalId);
    const observed = options.runtime.readCapturedSession(flight.lead.binding);
    if (!observed.attached || observed.record?.phase !== 'allocated' ||
        observed.record.custody !== 'owned' || observed.record.sealed) return held();
    if (checkCapture) flight.captured?.assertCurrent();
  }
}

/** Capture every actual original target wrapper, including older retained runs, before awaiting. */
function targetEntries(options: LiveRosterExecutionOptions, team: HostedTeam, memberId: string): Target[] {
  const rows: Target[] = [], bindings = new Set<string>();
  for (const entry of options.entries.values()) {
    if (entry.team.owner !== team.owner || entry.binding.teamId !== team.definition.binding.teamId ||
        entry.binding.memberId !== memberId) continue;
    const retained = options.retainedLaunches.get(runtimeDigest({ teamId: entry.binding.teamId,
      launchId: entry.binding.runId }));
    if (!retained || retained.team.owner !== team.owner) return held();
    const journal = retained.launch.liveMembership(callback => team.owner.withLaunchAuthority(
      options.profile.principalId, 'read', () => callback()));
    const history = journal.inspect(memberId);
    // Earlier membership wrappers keep their own complete source selection, provider and endpoint.
    // Logical Runtime closure alone does not discard those remaining cleanup responsibilities.
    const expected = equal(history.member?.binding, entry.binding) ? history.member
      : history.history.find(row => equal(row.intent.source?.binding, entry.binding))?.intent.source;
    if (!expected) return held();
    if (expected.configurationDigest !== runtimeDigest(entry.profile) ||
        expected.runtimeGeneration !== entry.profile.generation) return held();
    const attempt = journal.attemptFor(entry.binding);
    if (!attempt || bindings.has(runtimeDigest(entry.binding))) return held();
    bindings.add(runtimeDigest(entry.binding));
    rows.push({ entry, binding: structuredClone(entry.binding), retained,
      expected, claimed: attempt.claimed, provider: entry.provider, endpoint: entry.endpoint });
  }
  return rows;
}

function selectedLiveLead(options: LiveRosterExecutionOptions, team: HostedTeam):
  { retained: RetainedNativeLaunch; lead: MemberEntry } | undefined {
  const current = options.capturedTeams.get(team.definition.binding.teamId);
  if (!current || current.owner !== team.owner) return undefined;
  const retained = options.retainedLaunches.get(runtimeDigest({ teamId: team.definition.binding.teamId,
    launchId: runId(current) }));
  if (!retained || retained.team !== current) return held();
  const lead = retained.entries.find(entry => entry.team.owner === team.owner &&
    entry.binding.runId === runId(current) && current.definition.members.some(member =>
      member.memberId === entry.binding.memberId && member.role === 'lead'));
  if (!lead) return held();
  const observed = options.runtime.readCapturedSession(lead.binding);
  if (!observed.attached || observed.record?.phase !== 'allocated' ||
      observed.record.custody !== 'owned' || observed.record.sealed) return undefined;
  if (lead.profile.provider === 'opencode') return held(); // Original alive OpenCode-led edit refusal.
  assertCapturedRosterCurrent(current);
  return { retained, lead };
}

async function retireTargetReadiness(options: LiveRosterExecutionOptions, flight: Flight, target: Target): Promise<void> {
  assertFlight(options, flight);
  target.retained.launch.retireModelReadiness(target.entry.profile.memberId);
  // Compensation already released this new flight's exact probe before reaching closeTarget.
  if (target.entry === flight.entry) return;
  const team = runtimeDigest(target.entry.team.definition.binding);
  const destination = runtimeDigest({ launchId: target.binding.runId, memberId: target.binding.memberId });
  const identity = runtimeDigest({ team, destination }), prior = flight.readinessCleanup.get(identity);
  if (prior) return prior;
  if (!options.modelReadiness) return held();
  const cleanup = options.modelReadiness.probes.cancelTeamPreparations(team, undefined, destination);
  flight.readinessCleanup.set(identity, cleanup);
  return cleanup;
}

/** Same original stop/provider/endpoint facts; no member lookup, new timeout, or second close admission. */
function closeTarget(options: LiveRosterExecutionOptions, flight: Flight, target: Target): Promise<boolean> {
  const identity = runtimeDigest(target.binding), prior = flight.closed.get(identity);
  if (prior) return prior;
  const pending = (async () => {
    assertFlight(options, flight);
    if (!equal(target.entry.binding, target.binding) || target.entry.provider !== target.provider ||
        target.entry.endpoint !== target.endpoint) return false;
    if (target.entry.profile.provider === 'opencode') {
      await retireTargetReadiness(options, flight, target);
      assertFlight(options, flight);
    }
    const before = options.runtime.readCapturedSession(target.binding), record = before.record;
    if (!record) {
      if (target.claimed || before.attached || target.provider) return false;
      target.endpoint?.revoke(); await target.endpoint?.close();
      assertFlight(options, flight);
      const after = options.runtime.readCapturedSession(target.binding);
      return !after.record && !after.attached;
    }
    if (!((record.phase === 'allocated' && record.custody === 'owned' && before.attached) ||
      ((record.phase === 'closed' || record.phase === 'unopened') &&
        record.custody === 'released' && !before.attached))) return false;
    // Same closure primitive as Restart/Skip, under the original captured admin authority.
    const closed = await closeRuntimeMember({
      sourceBinding: target.binding,
      runtime: {
        readSession: binding => options.runtime.readCapturedSession(binding),
        stopSession: (binding, assertAuthority) => {
          assertAuthority?.();
          return options.runtime.stopCapturedSession(binding);
        },
      },
      assertOriginalAuthority: () => assertFlight(options, flight),
      retireOriginal: async () => {
        if (target.provider && !(await target.provider.cleanup())) return false;
        target.endpoint?.revoke(); await target.endpoint?.close();
        return true;
      },
    });
    return closed();
  })();
  flight.closed.set(identity, pending);
  return pending;
}

async function closeOriginalTargets(options: LiveRosterExecutionOptions, flight: Flight): Promise<void> {
  for (const target of flight.targets) if (!(await closeTarget(options, flight, target))) return held();
}

/** Original management owner cleanup only; an absent/unknown original row is never a release receipt. */
async function releaseProbe(options: LiveRosterExecutionOptions, flight: Flight): Promise<boolean> {
  if (!flight.probe) return true;
  if (!options.modelReadiness) return false;
  try {
    await options.modelReadiness.probes.cancelRetained(flight.probe.commandId, flight.probe.context);
    return true;
  } catch { return false; }
}

function hold(flight: Flight): LiveRosterResponse {
  try { flight.launch.hold(flight.original.commandId); } catch { /* Original persisted debt remains. */ }
  try { return flight.owner.hold(flight.original); }
  catch { return { ok: false, code: 'hold', outcome: 'unknown' }; }
}

async function rejectReleased(options: LiveRosterExecutionOptions, flight: Flight,
  error: unknown): Promise<LiveRosterResponse> {
  if (!(await releaseProbe(options, flight))) return hold(flight);
  const cleanup = await Promise.allSettled([...flight.readinessCleanup.values(), ...flight.closed.values()]);
  if (cleanup.some(result => result.status === 'rejected' || result.value === false)) return hold(flight);
  try {
    assertFlight(options, flight);
    const row = flight.owner.original(flight.original);
    if (row.liveMembership.publication) {
      if (row.liveMembership.delta.kind === 'remove') return hold(flight);
      if (flight.entry) {
        const summary = flight.retained.launch.read(), attempt = summary.members.find(value =>
          value.memberId === flight.entry!.binding.memberId);
        if (!attempt || !equal(attempt.binding, flight.entry.binding)) return hold(flight);
        const target: Target = { entry: flight.entry, binding: structuredClone(flight.entry.binding),
          retained: flight.retained, expected: flight.captured!.expected,
          claimed: attempt.attempt.claimed, provider: flight.entry.provider, endpoint: flight.entry.endpoint };
        if (!(await closeTarget(options, flight, target))) return hold(flight);
      } else {
        if (flight.openingInvoked || !flight.captured?.expected.binding) return hold(flight);
        const observed = options.runtime.readCapturedSession(flight.captured.expected.binding);
        if (observed.attached || observed.record) return hold(flight);
      }
      flight.owner.compensating(flight.original);
      const result = flight.owner.rejectReleased(flight.original, code(error));
      const compensated = flight.owner.original(flight.original);
      const selected = flight.launch.read(flight.original.commandId).phase === 'selected';
      flight.launch.rejectReleased(flight.original.commandId, selected ? compensated.revision : undefined);
      // Its selected wrapper remains retained for custody/history, with no work authority.
      options.onProgress(); return result;
    }
    // A completed immutable capture is the original finite preparation boundary. Interrupted
    // worktree/MCP capture has no equivalent release proof and deliberately remains held.
    if (!flight.captured) return hold(flight);
    const result = flight.owner.rejectReleased(flight.original, code(error));
    flight.launch.rejectReleased(flight.original.commandId);
    options.onProgress(); return result;
  } catch { return hold(flight); }
}

async function prepareModel(options: LiveRosterExecutionOptions, flight: Flight,
  input: LiveRosterOperation): Promise<void> {
  const captured = flight.captured!;
  if (captured.profile.provider !== 'opencode') {
    if (input.localModelReadinessOrigin !== undefined) return held();
    return;
  }
  const management = options.modelReadiness, origin = input.localModelReadinessOrigin;
  if (!management || !origin) return held();
  const commandId = `live-model-${runtimeDigest({ commandId: input.commandId, capture: captured.view.captureDigest })}`;
  const context = runtimeDigest({ team: flight.team.definition.binding, commandId: input.commandId,
    capture: captured.view.captureDigest });
  const prepared = captureReadinessPreparation(origin, {
    kind: 'team', owner: flight.input.binding.owner, contextId: origin.origin.contextId,
    commandId: flight.input.commandId,
    selection: { handleId: flight.input.binding.handleId, scope: flight.input.binding.scope,
      payload: flight.input.payload, liveRosterCapture: captured.view },
    workspaces: [captured.profile.cwd],
    targets: [{ workspace: captured.profile.cwd, providerId: captured.profile.nativeOptions.providerId }],
    anchorCommandId: commandId, original: management.probes.readPreparation(commandId), admittedAt: Date.now(),
  });
  prepared.anchor.expiresAt = Math.min(prepared.anchor.expiresAt, flight.cutoff);
  const profile = teamModelProbeProfile(captured.profile), subset = originalReadinessSubset(
    prepared.origin, captured.profile.cwd, captured.profile.nativeOptions.providerId);
  const cutoff = Math.min(flight.cutoff, prepared.anchor.expiresAt);
  const current = () => { try { assertFlight(options, flight, true); return Date.now() < cutoff; }
    catch { return false; } };
  const processOrigin = captureLiveRosterProcessOrigin(options.profile, flight.team,
    captured.capture, captured.profile, options.sources);
  // Publish the exact group identity in this first flight before its original ModelProbeOwner call.
  flight.probe = { commandId, context };
  flight.reference = await prepareTeamModelReadiness({ management, profile: captured.profile,
    commandId, context, cutoff,
    ...(processOrigin ? { processOrigin } : {}),
    scope: { schemaVersion: 1, kind: 'team', teamBindingDigest: runtimeDigest(flight.team.definition.binding),
      actionDigest: runtimeDigest({ commandId: flight.input.commandId, context }),
      selectionDigest: runtimeDigest({ payload: flight.input.payload, capture: captured.view }),
      sourceRevision: captured.view.captureDigest, rosterRevision: flight.receipt.liveMembership.input.expectedRevision,
      mechanismDigest: modelReadinessMechanismDigest(profile), workspace: captured.profile.cwd, cutoff,
      destinationKeys: [runtimeDigest({ launchId: flight.intent.launchId, memberId: captured.profile.memberId })] },
    prepared: { anchor: prepared.anchor, origin: subset }, isCurrent: current });
  assertFlight(options, flight, true);
}

async function continueFirst(options: LiveRosterExecutionOptions, flight: Flight,
  input: LiveRosterOperation): Promise<LiveRosterResponse> {
  try {
    const captured = flight.captured;
    if (!captured || input.conversation.phase !== 'continue' ||
        input.conversation.captureDigest !== captured.view.captureDigest) return held();
    flight.cutoff = Math.min(flight.cutoff, Date.now() + input.conversation.remainingMs);
    assertFlight(options, flight, true);
    flight.owner.preparing(flight.original, captured.view.captureDigest);
    // Freeze original target cleanup before admitting the new proof for this same run/member.
    const cleanup = flight.targets.filter(target => target.entry.profile.provider === 'opencode')
      .map(target => retireTargetReadiness(options, flight, target));
    if (cleanup.length && (await Promise.allSettled(cleanup)).some(result => result.status === 'rejected')) return hold(flight);
    assertFlight(options, flight, true);
    // Readiness precedes target publication/claim/endpoint. It never reuses the lead's proof or cwd.
    await prepareModel(options, flight, input);
    await closeOriginalTargets(options, flight);
    assertFlight(options, flight, true);
    const published = flight.owner.publishTarget(flight.original, captured.selection);
    flight.launch.publish(flight.original.commandId, published.revision);
    const targetTeam = liveRosterTargetTeam(flight.retained.team, captured, published.revision);
    const entry = createMemberEntry({ root: options.profile.owner.storageRoot,
      ownerId: options.profile.owner.ownerId, team: targetTeam, baseProfile: captured.profile });
    entry.liveRosterCapture = structuredClone(captured.capture);
    flight.entry = entry;
    if (options.entries.has(runtimeDigest(entry.binding))) return held();
    if (captured.profile.provider === 'opencode') {
      if (!flight.reference) return held();
      attachMemberModelReadiness({ launch: flight.retained.launch, entry, reference: flight.reference,
        commandId: flight.input.commandId,
        actorDigest: runtimeDigest({ principalId: flight.original.principalId, revision: flight.original.authorityRevision }),
        inputDigest: flight.requestDigest, cutoff: flight.cutoff,
        authorized: callback => flight.owner.withOriginal(flight.original, callback) });
    }
    // Only the selected wrapper changes in the array already closed over by the original launch.
    options.entries.set(runtimeDigest(entry.binding), entry);
    const previous = flight.retained.entries.findIndex(row => row.profile.memberId === entry.profile.memberId);
    if (previous < 0) flight.retained.entries.push(entry); else flight.retained.entries[previous] = entry;
    assertFlight(options, flight, true);
    flight.openingInvoked = true;
    const opening = flight.retained.launch.startMember(entry.profile.memberId,
      () => assertFlight(options, flight, true), flight.input.commandId);
    if (!opening) return held();
    await opening;
    assertFlight(options, flight, true);
    const observed = options.runtime.readCapturedSession(entry.binding), summary = flight.retained.launch.read();
    const selected = summary.members.find(row => row.memberId === entry.profile.memberId);
    if (!observed.attached || observed.record?.phase !== 'allocated' || observed.record.custody !== 'owned' ||
        observed.record.sealed || !selected || !equal(selected.binding, entry.binding) ||
        selected.attempt.status !== 'ready' || !selected.attempt.nativeReady ||
        !selected.attempt.contextApplied || !selected.attempt.usable) return held();
    const result = flight.owner.complete(flight.original);
    options.onProgress(); return result;
  } catch (error) { return rejectReleased(options, flight, error); }
}

async function captureFirst(options: LiveRosterExecutionOptions, flight: Flight): Promise<LiveRosterResponse> {
  try {
    if (flight.intent.kind === 'remove') {
      await closeOriginalTargets(options, flight);
      assertFlight(options, flight);
      const published = flight.owner.publishTarget(flight.original);
      flight.launch.publish(flight.original.commandId, published.revision);
      // Keep the exact removed wrapper for the original lifecycle/offline custody walk.
      const result = flight.owner.complete(flight.original);
      options.onProgress(); return result;
    }
    assertFlight(options, flight, true);
    const previousEntry = flight.targets.find(row => equal(row.expected, flight.intent.previous))?.entry;
    const previousCapture = previousEntry?.team.capture === undefined ? undefined
      : runtimeCaptureSourceSchema.parse(previousEntry.team.capture);
    const previousPlan = previousCapture?.worktrees?.find(row => row.memberIds.includes(flight.intent.memberId));
    const previousWorktree = previousEntry?.liveRosterCapture?.worktree?.binding ??
      previousCapture?.worktreeBindings?.find(row => row.slotId === previousPlan?.plan.slotId);
    flight.captured = await captureLiveRosterMember({ profile: options.profile, team: flight.retained.team,
      lead: flight.lead!, ...(options.sources ? { sources: options.sources } : {}),
      original: flight.receipt, intent: flight.intent,
      launch: flight.launch, ...(previousWorktree ? { previousWorktree } : {}),
      assertCurrent: () => assertFlight(options, flight, true, false),
      withAuthority: callback => flight.owner.withOriginal(flight.original, callback) });
    assertFlight(options, flight, true);
    flight.owner.captured(flight.original, flight.captured.view);
    return parseLiveRosterResponse({ ok: true, liveRosterCapture: flight.captured.view });
  } catch { return hold(flight); }
}

function firstFlight(options: LiveRosterExecutionOptions, input: LiveRosterOperation, team: HostedTeam,
  owner: TeamLiveRosterMembership, preview: LiveRosterPreview, requestDigest: string,
  selected: { retained: RetainedNativeLaunch; lead?: MemberEntry }, targets: Target[], admittedAt: number): Flight {
  if (input.conversation.phase !== 'capture') return held();
  const retained = selected.retained, sourceCaptureDigest = runtimeDigest(retained.team.capture ?? null);
  const source = { launchId: runId(retained.team), sourceCaptureDigest,
    hostIncarnation: options.hostIncarnation, cutoff: admittedAt + input.conversation.remainingMs,
    assertCurrent() {
      options.assertCurrent(input.teamId);
      if (retained.team.owner !== team.owner || runtimeDigest(retained.team.capture ?? null) !== sourceCaptureDigest ||
          options.retainedLaunches.get(runtimeDigest({ teamId: input.teamId, launchId: runId(retained.team) })) !== retained)
        return held();
    } };
  const admitted = owner.begin(options.profile.principalId, preview.input, requestDigest, source);
  if (!admitted.fresh) return held();
  const original: LiveRosterOriginal = { ...source, principalId: options.profile.principalId,
    commandId: input.commandId, fingerprint: admitted.record.fingerprint, requestDigest,
    authorityRevision: admitted.record.liveMembership.authorityRevision };
  const launch = retained.launch.liveMembership(callback => owner.withOriginal(original, callback));
  const selectedMember = launch.inspect(preview.delta.targetId).member;
  const previous = [...targets].sort((a, b) => (b.expected.runtimeGeneration ?? -1) - (a.expected.runtimeGeneration ?? -1))[0]?.expected
    ?? selectedMember;
  if (preview.delta.kind === 'remove' && !previous) return held();
  const intent: LiveLaunchIntent = { commandId: input.commandId, requestDigest,
    originalFingerprint: admitted.record.fingerprint, authorityRevision: original.authorityRevision,
    principalId: original.principalId, launchId: source.launchId, sourceCaptureDigest,
    expectedRevision: preview.input.expectedRevision, hostIncarnation: source.hostIncarnation,
    cutoff: source.cutoff, kind: preview.delta.kind, memberId: preview.delta.targetId,
    source: selectedMember, previous };
  if (!launch.begin(intent)) return held();
  return { input: structuredClone(input), requestDigest, bindingDigest: runtimeDigest(input.binding), team,
    retained, ...(selected.lead ? { lead: selected.lead } : {}), owner, original, receipt: admitted.record, launch, targets, intent,
    cutoff: source.cutoff, continuation: false, openingInvoked: false, closed: new Map(), readinessCleanup: new Map() };
}

/** One original full-roster action, with a private first-call capture/continuation and read-only recovery. */
export async function executeLiveRosterMembership(options: LiveRosterExecutionOptions,
  supplied: LiveRosterOperation): Promise<LiveRosterResponse> {
  const admittedAt = Date.now();
  const input = structuredClone(supplied);
  // Read binds the same original replacement, inside the existing closed lookup envelope.
  const originalPayload = input.method === 'team.roster.lookup'
    ? z.object({ expected: z.unknown() }).strict().parse(input.payload).expected : input.payload;
  const payload = replaceRosterPayloadSchema.parse(originalPayload);
  const original = replaceRosterSchema.parse({ ...payload, commandId: input.commandId });
  envelopeSchema.parse({ commandId: input.commandId, binding: input.binding, payload: input.payload });
  input.conversation = parseLiveRosterPrivateInput(input.method, input.conversation, input.localModelReadinessOrigin);
  input.payload = originalPayload;
  options.assertCurrent(input.teamId);
  const team = options.teams.get(input.teamId) ?? options.capturedTeams.get(input.teamId);
  if (!team || input.binding.scope.teamId !== input.teamId || !equal(input.binding.scope, team.definition.scope)) return held();
  const owner = team.owner.nativeRoster.liveMembership(), requestDigest = digest({ commandId: input.commandId, payload: input.payload });
  const known = owner.lookup(options.profile.principalId, original, requestDigest);
  const flightKey = key(input.teamId, input.commandId), byCommand = flights.get(options.runtime);
  const flight = byCommand?.get(flightKey);
  if (flight && (flight.requestDigest !== requestDigest || flight.bindingDigest !== runtimeDigest(input.binding) ||
      flight.original.hostIncarnation !== options.hostIncarnation)) throw new TeamOwnerError('conflict');
  if (input.conversation.phase === 'read')
    return known ?? { ok: false, code: 'hold', outcome: 'unknown' };
  if (input.conversation.phase === 'continue') {
    if (!known || !flight || flight.continuation || !flight.captured ||
        input.conversation.captureDigest !== flight.captured.view.captureDigest)
      return known ?? { ok: false, code: 'hold', outcome: 'unknown' };
    flight.continuation = true; // First original callback only; no later retry/cold admission.
    return options.trackOpening(continueFirst(options, flight, input));
  }
  if (known) return known;
  const preview = owner.preview(options.profile.principalId, original);
  const selected = selectedLiveLead(options, team);
  const targets = preview ? targetEntries(options, team, preview.delta.targetId) : [];
  // An original Remove must retire retained target debt even when mutable Team is no longer alive.
  const retainedRemove = preview?.delta.kind === 'remove' && targets.length > 0;
  if (!selected && !retainedRemove) {
    options.assertRosterEditable(input.teamId, team.connection.readRoster().members);
    const value = team.connection.replaceRoster(original);
    return parseLiveRosterResponse({ ok: true, value });
  }
  if (!preview) throw new TeamOwnerError('hold');
  if (preview.delta.kind !== 'remove' && !selected) return held();
  const actual = selected ?? { retained: targets[0]!.retained };
  const retained = firstFlight(options, input, team, owner, preview, requestDigest, actual, targets, admittedAt);
  const map = byCommand ?? new Map<string, Flight>();
  if (!byCommand) flights.set(options.runtime, map);
  map.set(flightKey, retained);
  return options.trackOpening(captureFirst(options, retained));
}
