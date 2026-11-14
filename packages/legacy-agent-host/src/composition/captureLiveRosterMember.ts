import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { effectId } from '../team/identity.js';
import { memberSettingsSchema, savedTeamSettingsSchema } from '../team/rosterSchema.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { liveExpectedMemberSchema } from '../team-launch/liveRosterMembership.js';
import { liveRosterValidationRecord, validateLiveRosterLaunch } from '../team-launch/liveRosterMembership.js';
import { validateLaunchRecord } from '../team-launch/validateLaunchRecord.js';
import { materializeWorktree } from '../team-launch/materializeWorktree.js';
import { launchWorktreePlanSchema, ownedWorktreeBindingSchema } from '../team-launch/worktreeSchema.js';
import { runtimeDigest, normalizeBinding } from '../runtime/identity.js';
import { initialContextDigest } from '../team-launch/context.js';
import { captureRuntimeExtraArgs } from './runtimeExtraArgs.js';
import { captureRuntimeMcp } from './captureRuntimeMcp.js';
import { inheritNativeMemberMcp } from './inheritNativeMemberMcp.js';
import { capturedMcpSourceCurrent } from '../mcp-catalog/capturedSource.js';
import { resolveRuntimeRecipe, resolveCapturedRuntimeRecipe, runtimeProviderId } from './runtimeRecipe.js';
import { runtimeSourceReferenceSchema } from './runtimeSourceContracts.js';
import { RuntimeSourceUnavailable } from './runtimeSourceGrantAuthority.js';
import { compileRuntimeMemberProfile, runtimeCaptureSourceSchema } from './runtimeCaptureSource.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import { runtimeWorktreeGit } from './runtimeWorktreeCapture.js';
import { memberInitialInstructions } from './TeamLaunchComposition.js';
import { createMemberEntry } from './createMemberEntry.js';
import { capturedRuntimeMcpReferencesSchema, prepareCapturedRuntimeMcpRecipes,
  loadCapturedRuntimeMcpRecipe, validateCapturedRuntimeMcpRecipe } from './capturedRuntimeMcpRecipes.js';
import type { JsonValue } from '../contracts.js';
import type { ExpectedLaunchMember, TeamLaunchRecord } from '../team-launch/contracts.js';
import type { createLiveRosterLaunch, LiveLaunchIntent } from '../team-launch/liveRosterMembership.js';
import type { OwnedWorktreeBinding } from '../team-launch/worktreeContracts.js';
import type { LiveRosterReceipt, LiveRosterCaptureView } from '../team/liveRosterMembership.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';

const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(8192).refine(value => isAbsolute(value) && !/[\0\r\n]/u.test(value));
const seedSchema = z.object({
  schemaVersion: z.literal(1), commandId: id, requestDigest: hash, sourceCaptureDigest: hash,
  expectedRevision: hash, launchId: id, sourceCwd: path,
  savedSettings: savedTeamSettingsSchema, leadProvider: z.enum(['anthropic', 'codex', 'opencode']),
  member: z.object({ memberId: id, name: id, role: z.literal('member'), settings: memberSettingsSchema }).strict(),
  sourceReference: runtimeSourceReferenceSchema.optional(), templateDigest: hash,
  previous: liveExpectedMemberSchema.nullable(),
}).strict();
export const liveRuntimeCaptureSchema = seedSchema.extend({
  workspace: path, worktree: z.object({ plan: launchWorktreePlanSchema, binding: ownedWorktreeBindingSchema }).strict().optional(),
  mcpRecipeReference: capturedRuntimeMcpReferencesSchema.element, recipeDigest: hash,
  configurationDigest: hash, runtimeGeneration: z.number().int().positive(),
}).strict();
export type LiveRuntimeCapture = z.infer<typeof liveRuntimeCaptureSchema>;
const held = (reason = 'live-roster-capture'): never => { throw new TeamLaunchError('hold', reason); };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;

function seedRecipe(profile: TeamHostProfile, team: HostedTeam, seed: z.infer<typeof seedSchema>,
  sources?: RuntimeRecipeSources, restoring = false): RuntimeMemberProfile {
  const base = resolveRuntimeRecipe(profile.runtime, team.definition.binding.teamId, seed.member.memberId,
    seed.member.settings.providerId ?? seed.leadProvider, restoring);
  if (runtimeDigest(base) !== seed.templateDigest) {
    if (restoring) throw new RuntimeSourceUnavailable();
    return held('live-roster-template-changed');
  }
  if (restoring && seed.sourceReference) {
    if (!sources) throw new RuntimeSourceUnavailable();
    sources.assertReferenceAvailable?.(seed.sourceReference, team.definition.scope, seed.sourceCwd);
  }
  const selected = resolveCapturedRuntimeRecipe(base, seed.sourceReference, team.definition.scope,
    seed.sourceCwd, sources);
  // A fresh product attachment never reuses a native conversation from a private exact-member recipe.
  if (selected.provider === 'opencode' && selected.nativeSessionId !== undefined)
    return held('live-roster-native-session');
  return captureRuntimeExtraArgs([selected], seed.savedSettings.extraCliArgs)[0]!;
}

function compile(profile: TeamHostProfile, team: HostedTeam, capture: LiveRuntimeCapture,
  sources?: RuntimeRecipeSources, restoring = false) {
  const store = new TeamOwnerStore(profile.owner.storageRoot, team.definition.binding.teamName);
  if (capture.mcpRecipeReference.memberId !== capture.member.memberId ||
      capture.launchId !== (team.launchId ?? team.definition.scope.runId) ||
      capture.sourceCaptureDigest !== runtimeDigest(team.capture ?? null) ||
      capture.worktree && (capture.workspace !== capture.worktree.plan.targetPath ||
        capture.worktree.binding.slotId !== capture.worktree.plan.slotId ||
        capture.worktree.binding.target.path !== capture.workspace)) return held();
  if (restoring) validateCapturedRuntimeMcpRecipe(store, capture.commandId,
    capture.mcpRecipeReference, capture.workspace);
  const base = { ...seedRecipe(profile, team, capture, sources, restoring), cwd: capture.workspace };
  const selected = loadCapturedRuntimeMcpRecipe(store, capture.commandId, base, capture.mcpRecipeReference, restoring);
  if (runtimeDigest(selected) !== capture.recipeDigest) {
    if (restoring) throw new RuntimeSourceUnavailable();
    return held('live-roster-recipe-changed');
  }
  const fresh = effectId('live-roster-agent', team.definition.binding.teamId, capture.commandId,
    capture.member.memberId, capture.requestDigest);
  const worktrees = capture.worktree ? [{ memberIds: [capture.member.memberId], plan: capture.worktree.plan }] : undefined;
  const original = compileRuntimeMemberProfile(selected, {
    commandId: capture.commandId, configurationRevision: capture.expectedRevision,
    savedSettings: capture.savedSettings, ...(worktrees ? { worktrees } : {}),
  }, capture.member, capture.leadProvider, capture.launchId);
  const runtimeGeneration = Math.max(selected.generation, capture.previous?.runtimeGeneration ?? -1) + 1;
  if (runtimeGeneration !== capture.runtimeGeneration || !Number.isSafeInteger(runtimeGeneration)) return held();
  const { configurationDigest: _configurationDigest, runtimeGeneration: _generation, ...origin } = capture;
  const compiled = runtimeMemberProfileSchema.parse({
    ...original, cwd: capture.workspace, generation: runtimeGeneration,
    principalId: `agent:${fresh}`, sessionId: effectId('live-roster-session', fresh),
    configRevision: `live-${runtimeDigest(origin)}`,
  });
  const digest = runtimeDigest(compiled);
  const delivery = { ...team.definition.binding, runId: capture.launchId, memberId: capture.member.memberId,
    generation: `live-${runtimeDigest({ commandId: capture.commandId, requestDigest: capture.requestDigest,
      previous: capture.previous?.binding ?? null })}` };
  const expected: ExpectedLaunchMember = {
    memberId: capture.member.memberId, binding: normalizeBinding(delivery),
    configurationDigest: digest,
    contextDigest: initialContextDigest(memberInitialInstructions(capture.member.name, 'member',
      team.definition.binding.teamName, capture.workspace)),
    configRevision: compiled.configRevision, skipped: false, timeoutMs: compiled.limits.timeoutMs,
    runtimeGeneration, baseConfigurationDigest: digest,
  };
  return { capture, profile: compiled, expected,
    selection: { principalId: compiled.principalId, delivery, configurationDigest: digest } };
}

/** Historical compilation is bounded read-only metadata reconstruction; never repeats workspace or native effects. */
export function compileLiveRosterMember(profile: TeamHostProfile, team: HostedTeam, raw: unknown,
  sources?: RuntimeRecipeSources, restoring = false) {
  liveRuntimeCaptureSchema.parse(raw);
  const capture = structuredClone(raw as LiveRuntimeCapture);
  if (Buffer.byteLength(JSON.stringify(capture)) > 512 * 1024) return held();
  const result = compile(profile, team, capture, sources, restoring);
  if (result.selection.configurationDigest !== capture.configurationDigest) {
    if (restoring) throw new RuntimeSourceUnavailable();
    return held('live-roster-configuration-changed');
  }
  return result;
}

/** Retain the original actual-cwd source before Main policy and before any target Runtime allocation. */
export async function captureLiveRosterMember(options: {
  profile: TeamHostProfile; team: HostedTeam; lead: MemberEntry; sources?: RuntimeRecipeSources;
  original: LiveRosterReceipt; intent: LiveLaunchIntent;
  launch: ReturnType<typeof createLiveRosterLaunch>;
  previousWorktree?: OwnedWorktreeBinding;
  assertCurrent(): void;
  withAuthority<T>(callback: () => T): T;
}) {
  const { profile, team, original, launch, intent } = options, delta = original.liveMembership.delta;
  if (delta.kind === 'remove' || !delta.after || options.lead.team.owner !== team.owner ||
      options.lead.binding.runId !== intent.launchId || options.lead.profile.provider === 'opencode') return held();
  const source = team.capture === undefined ? undefined : runtimeCaptureSourceSchema.parse(team.capture);
  const savedSettings = source?.savedSettings ?? team.definition.savedSettings;
  if (!savedSettings) return held('live-roster-saved-settings');
  const member = { memberId: delta.targetId, name: delta.after.name, role: 'member' as const,
    settings: structuredClone(delta.after.settings ?? {}) };
  const leadProvider = runtimeProviderId(options.lead.profile), sourceCwd = member.settings.cwd ?? savedSettings.cwd;
  const template = resolveRuntimeRecipe(profile.runtime, team.definition.binding.teamId,
    member.memberId, member.settings.providerId ?? leadProvider);
  const sourceReference = options.sources?.currentForRecipe(team.definition.scope, sourceCwd, template);
  const seed = seedSchema.parse({ schemaVersion: 1, commandId: intent.commandId,
    requestDigest: intent.requestDigest, sourceCaptureDigest: intent.sourceCaptureDigest,
    expectedRevision: intent.expectedRevision, launchId: intent.launchId, sourceCwd,
    savedSettings: structuredClone(savedSettings), leadProvider, member,
    ...(sourceReference ? { sourceReference } : {}), templateDigest: runtimeDigest(template),
    previous: intent.previous });
  const current = () => {
    options.assertCurrent();
    if (Date.now() >= intent.cutoff || runtimeDigest(team.capture ?? null) !== seed.sourceCaptureDigest ||
        !capturedMcpSourceCurrent(options.lead.profile) ||
        runtimeDigest(options.sources?.currentForRecipe(team.definition.scope, sourceCwd, template) ?? null) !==
          runtimeDigest(sourceReference ?? null)) return held('live-roster-source-current');
    seedRecipe(profile, team, seed, options.sources);
  };
  current(); launch.seed(intent.commandId, json(seed));
  let workspace = sourceCwd, worktree: LiveRuntimeCapture['worktree'];
  const isolated = member.settings.isolation === 'worktree';
  const named = !isolated && member.settings.cwd === undefined ? savedSettings.worktree?.trim() : undefined;
  if (isolated || named) {
    const git = runtimeWorktreeGit(profile);
    let previous = options.previousWorktree;
    if (named) {
      const leadPlan = source?.worktrees?.find(row => row.memberIds.includes(options.lead.profile.memberId));
      previous = source?.worktreeBindings?.find(row => row.slotId === leadPlan?.plan.slotId);
      if (!leadPlan || !previous || source?.savedSettings.worktree?.trim() !== named ||
          previous.target.path !== leadPlan.plan.targetPath) return held('live-roster-named-worktree');
    }
    const plan = await git.plan({ baseCwd: isolated ? sourceCwd : savedSettings.cwd,
      teamId: team.definition.binding.teamId,
      slot: isolated ? { kind: 'member', name: member.memberId } : { kind: 'named', name: named! },
      ...(previous ? { previous } : {}) });
    current(); launch.plan(intent.commandId, plan);
    const binding = await materializeWorktree(plan, git, {
      assertCurrent: current,
      read: () => {
        const receipt = launch.readWorktree(intent.commandId);
        return { plan, ...(receipt ? { receipt } : {}) };
      },
      write: (next, expected) => launch.writeWorktree(intent.commandId, next, expected),
    });
    current(); workspace = plan.targetPath; worktree = { plan, binding };
  }
  const base = { ...seedRecipe(profile, team, seed, options.sources), cwd: workspace };
  const policy = member.settings.mcpPolicy;
  // Inherit the actual live lead's frozen allowlist. Explicit target policy reads only the target cwd;
  // the lead placeholder supplies its retained servers and never re-reads/replans a peer catalog.
  const { mcpCatalogSource: _leadCatalog, ...leadWithoutCatalog } = options.lead.profile;
  const candidate = !policy || policy.mode === 'inheritLead'
    ? inheritNativeMemberMcp(base, options.lead.profile)
    : captureRuntimeMcp({ recipes: [leadWithoutCatalog as RuntimeMemberProfile, base], savedCwd: workspace,
      members: [{ role: 'lead', settings: {} }, { ...member, settings: { ...member.settings, cwd: workspace } }] })[1]!;
  const store = new TeamOwnerStore(profile.owner.storageRoot, team.definition.binding.teamName);
  const references = await prepareCapturedRuntimeMcpRecipes({ store, commandId: intent.commandId,
    baseRecipes: [base], selectedRecipes: [candidate], assertCurrent: current, withAuthority: options.withAuthority });
  current(); const reference = references[0];
  if (references.length !== 1 || !reference) return held();
  const recipe = loadCapturedRuntimeMcpRecipe(store, intent.commandId, base, reference);
  const pending = { ...seed, workspace, ...(worktree ? { worktree } : {}),
    mcpRecipeReference: reference, recipeDigest: runtimeDigest(recipe),
    runtimeGeneration: Math.max(recipe.generation, intent.previous?.runtimeGeneration ?? -1) + 1,
    configurationDigest: '0'.repeat(64) };
  // The profile commitment excludes this derived hash itself; a cold compile checks it again.
  const result = compile(profile, team, pending, options.sources);
  const capture = { ...pending, configurationDigest: result.selection.configurationDigest };
  liveRuntimeCaptureSchema.parse(capture);
  const compiled = compileLiveRosterMember(profile, team, capture, options.sources);
  current(); launch.capture(intent.commandId, json(capture), compiled.expected);
  const view: LiveRosterCaptureView = {
    schemaVersion: 1, commandId: intent.commandId, teamId: team.definition.binding.teamId,
    requestDigest: intent.requestDigest, expectedRevision: intent.expectedRevision,
    launchId: intent.launchId, sourceCaptureDigest: intent.sourceCaptureDigest, captureDigest: runtimeDigest(capture),
    target: { memberId: member.memberId, name: member.name, provider: compiled.profile.provider,
      modelProviderId: compiled.profile.provider === 'opencode' ? compiled.profile.nativeOptions.providerId : null,
      modelId: compiled.profile.model, workspace: compiled.profile.cwd,
      optionsDigest: runtimeDigest(compiled.profile.nativeOptions ?? {}),
      configurationDigest: compiled.selection.configurationDigest },
  };
  return { ...compiled, view, assertCurrent: current };
}

/** The original run/owner remains unchanged; this view contains only the newly compiled target. */
export function liveRosterTargetTeam(team: HostedTeam, compiled: ReturnType<typeof compileLiveRosterMember>,
  revision: string): HostedTeam {
  const member = { ...structuredClone(compiled.capture.member), delivery: structuredClone(compiled.selection.delivery) };
  return { ...team, configurationRevision: revision, definition: { ...structuredClone(team.definition),
    members: [member], grants: [{ principalId: compiled.profile.principalId, memberName: member.name,
      permissions: ['read', 'task.write', 'message.write', 'process.write'] }] } };
}

/** Validate original Team/launch joins before consulting any current private source recipe. */
function retainedLiveCaptures(profile: TeamHostProfile, team: HostedTeam) {
  const store = new TeamOwnerStore(profile.owner.storageRoot, team.definition.binding.teamName);
  const launchId = team.launchId ?? team.definition.scope.runId;
  const name = `launches/${runtimeDigest(launchId)}.json`;
  let stat;
  try { stat = lstatSync(join(store.directory, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return held('live-roster-record');
  const record = store.read<TeamLaunchRecord>(name);
  if (!record || record.definition.launchId !== launchId || record.fingerprint !== runtimeDigest(record.definition))
    return held('live-roster-record');
  validateLiveRosterLaunch(record);
  validateLaunchRecord(liveRosterValidationRecord(record), record.fingerprint, record.definition.members.length);
  if (!record.liveMembership?.length) return [];
  const receipts = team.owner.nativeRoster.liveMembership().retained(profile.principalId);
  return record.liveMembership.flatMap(row => {
    const receipt = receipts.find(value => value.commandId === row.intent.commandId);
    const original = receipt?.liveMembership;
    if (!receipt || !original || receipt.fingerprint !== row.intent.originalFingerprint ||
        receipt.principalId !== row.intent.principalId || original.authorityRevision !== row.intent.authorityRevision ||
        original.requestDigest !== row.intent.requestDigest || original.launchId !== launchId ||
        original.sourceCaptureDigest !== row.intent.sourceCaptureDigest ||
        original.sourceCaptureDigest !== runtimeDigest(team.capture ?? null) ||
        original.input.expectedRevision !== row.intent.expectedRevision || original.cutoff !== row.intent.cutoff ||
        original.hostIncarnation !== row.intent.hostIncarnation || original.delta.targetId !== row.intent.memberId ||
        original.delta.kind !== row.intent.kind) return held('live-roster-receipt');
    if (['selected', 'removed', 'compensated'].includes(row.phase) && (!original.publication ||
        row.rosterRevision !== (row.phase === 'compensated' ? original.compensation?.afterRevision
          : original.publication.afterRevision))) return held('live-roster-publication');
    if (row.phase === 'selected' && original.compensation) return held('live-roster-compensation-pending');
    if (!row.capture) return [];
    liveRuntimeCaptureSchema.parse(row.capture);
    const capture = row.capture as LiveRuntimeCapture;
    if (capture.commandId !== row.intent.commandId || capture.requestDigest !== original.requestDigest ||
        capture.expectedRevision !== original.input.expectedRevision || capture.member.memberId !== row.intent.memberId ||
        capture.configurationDigest !== row.selected?.baseConfigurationDigest ||
        original.capture && original.capture.captureDigest !== row.captureDigest) return held('live-roster-capture');
    validateCapturedRuntimeMcpRecipe(store, capture.commandId, capture.mcpRecipeReference, capture.workspace);
    return [{ row, receipt, capture, current: record.definition.members.find(value => value.memberId === row.intent.memberId) }];
  });
}

export function validateRetainedLiveRuntimeEntries(profile: TeamHostProfile, team: HostedTeam): void {
  retainedLiveCaptures(profile, team);
}

/** Metadata-only cold recovery. Pending capture/continuation never becomes a new probe, claim or open. */
export function restoreLiveRosterRuntimeEntries(options: {
  profile: TeamHostProfile; team: HostedTeam; entries: MemberEntry[]; registry: Map<string, MemberEntry>;
  sources?: RuntimeRecipeSources; restoring?: boolean;
}): void {
  const { profile, team } = options;
  for (const { row, receipt, capture, current } of retainedLiveCaptures(profile, team)) {
    if (!['selected', 'compensated'].includes(row.phase)) continue;
    const compiled = compileLiveRosterMember(profile, team, capture, options.sources, options.restoring);
    if (runtimeDigest(compiled.expected) !== runtimeDigest(row.selected) ||
        runtimeDigest(compiled.selection) !== runtimeDigest(receipt.liveMembership.selection)) return held('live-roster-selection');
    const target = liveRosterTargetTeam(team, compiled, receipt.revision);
    const entry = createMemberEntry({ root: profile.owner.storageRoot, ownerId: profile.owner.ownerId,
      team: target, baseProfile: compiled.profile, ...(options.restoring ? { restoring: true } : {}) });
    entry.liveRosterCapture = structuredClone(compiled.capture);
    const key = runtimeDigest(entry.binding), prior = options.registry.get(key);
    if (prior && (runtimeDigest(prior.baseProfile) !== runtimeDigest(entry.baseProfile) ||
        runtimeDigest(prior.liveRosterCapture ?? null) !== runtimeDigest(entry.liveRosterCapture))) return held('live-roster-binding');
    const selected = prior ?? entry;
    if (!prior) options.registry.set(key, selected);
    if (!current || runtimeDigest(current.binding) !== runtimeDigest(selected.binding)) continue;
    const index = options.entries.findIndex(value => value.profile.memberId === selected.profile.memberId);
    if (index < 0) options.entries.push(selected); else options.entries[index] = selected;
  }
}
