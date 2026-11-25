import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { runtimeDigest } from '../runtime/identity.js';
import { effectId } from '../team/identity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { applyLaunchConfiguration } from './launchConfiguration.js';
import { capturedWorkspaceIdentity } from './capturedWorkspaceIdentity.js';
import { resolveCapturedRuntimeRecipe, resolveRuntimeRecipe } from './runtimeRecipe.js';
import { captureRuntimeExtraArgs } from './runtimeExtraArgs.js';
import { scheduledRunInputSchema } from './scheduledRunContracts.js';
import { runtimeSourceReferenceSchema } from './runtimeSourceContracts.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { ScheduledRunInput } from './scheduledRunContracts.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import type { RuntimeBinding } from '../runtime/contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z.object({
  schemaVersion: z.literal(1), input: scheduledRunInputSchema,
  teamScope: hash, memberId: z.string().min(1).max(256),
  authorityRevision: z.number().int().positive(),
  source: runtimeSourceReferenceSchema.optional(), recipeDigest: hash,
  workspaceIdentity: hash, capturedAt: z.string().datetime(),
}).strict();
export type ScheduledRunCapture = z.infer<typeof schema>;
export interface ScheduledRunSelection {
  team: HostedTeam;
  capture: ScheduledRunCapture;
  store: TeamOwnerStore;
  binding: RuntimeBinding;
  config: OpenConfig;
}
const locator = (runId: string) => `scheduled-runs/${runtimeDigest(runId)}.json`;

export function readScheduledRunCapture(store: TeamOwnerStore, runId: string): ScheduledRunCapture | undefined {
  try {
    const stat = lstatSync(join(store.directory, locator(runId)));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new RuntimeOwnerError('hold');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const saved = schema.parse(store.read(locator(runId)));
  if (saved.input.runId !== runId) throw new RuntimeOwnerError('conflict');
  return saved;
}

/** Immutable app intent beside existing launch captures; Runtime remains the only effect journal. */
export function captureScheduledRun(options: {
  profile: TeamHostProfile; team: HostedTeam; input: ScheduledRunInput; sources?: RuntimeRecipeSources;
}): ScheduledRunCapture {
  const { profile, team, input } = options;
  return team.owner.withLaunchAuthority(profile.principalId, 'control', authorityRevision => {
    const store = new TeamOwnerStore(profile.owner.storageRoot, team.definition.binding.teamName);
    const prior = readScheduledRunCapture(store, input.runId);
    if (prior) {
      if (runtimeDigest(prior.input) !== runtimeDigest(input) || prior.teamScope !== runtimeDigest(team.definition.scope))
        throw new RuntimeOwnerError('conflict');
      return prior;
    }
    const roster = team.connection.readRoster(), leads = roster.members.filter(member => member.role === 'lead');
    if (roster.revision !== input.expectedRosterRevision || leads.length !== 1 ||
      !roster.savedSettings || roster.savedSettings.cwd !== input.config.cwd)
      throw new RuntimeOwnerError('conflict');
    const recipe = resolveRuntimeRecipe(profile.runtime, team.definition.binding.teamId,
      leads[0]!.memberId, input.config.providerId ?? 'anthropic');
    const source = options.sources?.currentForRecipe(team.definition.scope, input.config.cwd, recipe);
    const capture: ScheduledRunCapture = {
      schemaVersion: 1, input, teamScope: runtimeDigest(team.definition.scope),
      memberId: leads[0]!.memberId, authorityRevision,
      ...(source ? { source } : {}), recipeDigest: runtimeDigest(recipe),
      workspaceIdentity: capturedWorkspaceIdentity(input.config.cwd), capturedAt: new Date().toISOString(),
    };
    // Reject unsupported choices before publishing an execution intent.
    scheduledRunProfile(profile, team, capture, options.sources);
    if (Buffer.byteLength(JSON.stringify(capture, null, 2) + '\n') > 512 * 1024)
      throw new RuntimeOwnerError('invalid');
    store.write(locator(input.runId), capture);
    return readScheduledRunCapture(store, input.runId)!;
  });
}

/** Original descriptor/template and retained source only; current selection never repairs a run. */
export function scheduledRunProfile(profile: TeamHostProfile, team: HostedTeam,
  capture: ScheduledRunCapture, sources?: RuntimeRecipeSources): RuntimeMemberProfile {
  const { input } = capture, choice = input.config;
  if (capture.teamScope !== runtimeDigest(team.definition.scope) ||
      capture.workspaceIdentity !== capturedWorkspaceIdentity(choice.cwd)) throw new RuntimeOwnerError('hold');
  const base = resolveRuntimeRecipe(profile.runtime, team.definition.binding.teamId,
    capture.memberId, choice.providerId ?? 'anthropic');
  if (runtimeDigest(base) !== capture.recipeDigest) throw new RuntimeOwnerError('hold');
  let selected = resolveCapturedRuntimeRecipe(base, capture.source, team.definition.scope, choice.cwd, sources);
  if (selected.provider === 'opencode') throw new RuntimeOwnerError('invalid');
  if (selected.provider === 'codex' && (input.maxTurns !== undefined || input.maxBudgetUsd !== undefined ||
      choice.allowedTools?.length || choice.disallowedTools?.length ||
      choice.providerBackendId && !['auto', 'codex-native'].includes(choice.providerBackendId)))
    throw new RuntimeOwnerError('invalid'); // The pinned native API does not implement these legacy flags.
  selected = applyLaunchConfiguration({ ...selected, cwd: choice.cwd }, {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
    ...(choice.resolvedFastMode === undefined ? {} : { fastMode: choice.resolvedFastMode }),
    permissions: choice.skipPermissions === false ? 'manual' : 'bypass',
  });
  if (selected.provider === 'claude') {
    const extra = [
      ...(input.maxTurns === undefined ? [] : ['--max-turns', String(input.maxTurns)]),
      ...(input.maxBudgetUsd === undefined ? [] : ['--max-budget-usd', String(input.maxBudgetUsd)]),
    ];
    selected = captureRuntimeExtraArgs([{ ...selected, extraArgs: [...(selected.extraArgs ?? []), ...extra],
      ...(choice.allowedTools?.length ? { autoAllowedTools: [...choice.allowedTools] } : {}) }], undefined)[0]!;
  }
  const identity = scheduledRunIdentity(profile, team, capture);
  return runtimeMemberProfileSchema.parse({ ...selected, sessionId: identity.config.sessionId,
    configRevision: identity.config.configRevision, generation: 0 });
}

export function scheduledRunIdentity(profile: TeamHostProfile, team: HostedTeam, capture: ScheduledRunCapture) {
  const binding: RuntimeBinding = { backendId: team.definition.binding.backendId,
    teamId: team.definition.binding.teamId, runId: 'scheduled-standalone',
    memberId: effectId('scheduled-member', capture.input.scheduleId), generation: capture.input.runId };
  const config: OpenConfig = { tenantId: profile.owner.ownerId, projectId: team.definition.scope.projectId,
    sessionId: effectId('scheduled-session', binding.teamId, capture.input.runId), generation: 0,
    configRevision: `scheduled-${runtimeDigest(capture)}`,
    requiredCapabilities: capture.input.config.providerId === 'codex' ? ['text', 'tools'] : ['session.conversation'] };
  return { binding, config };
}
