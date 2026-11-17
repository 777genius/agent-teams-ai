import { runtimeLaunchMembers } from './runtimeLaunchMembers.js';
import { z } from 'zod';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { effectId } from '../team/identity.js';
import { assertRuntimeWorktree } from './runtimeWorktreeCapture.js';
import { assertCapturedRosterCurrent, isUnstartedCaptureEditable } from './teamRoster.js';
import {
  modelConfigurationFromLaunch,
  readSavedTeamModelConfiguration,
} from './savedTeamModelProbe.js';
import { readLaunchRestorations } from './readLaunchRestorations.js';
import { prepareLaunchResume } from './prepareLaunchResume.js';
import { executeTeamLaunch } from './executeTeamLaunch.js';
import { runtimeControlId as id } from './runtimeControlValues.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { JsonValue } from '../contracts.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import { attachMemberModelReadiness, captureActionModelReadiness,
  capturePreparedModelReference, prepareCapturedLaunchReadiness } from './prepareTeamModelReadiness.js';
import type { CaptureModelReadinessTransfer, LocalModelReadinessAction } from './prepareTeamModelReadiness.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import { applyLaunchConfiguration, launchConfigurationSchema } from './launchConfiguration.js';
import { attachInitialRuntimeModelAdmission } from './initialRuntimeModelAdmission.js';

export type RuntimeLaunchAsyncOperation = 'capture' | 'start' | 'retry';
export type RuntimeLaunchSyncOperation =
  | 'read'
  | 'configuration.read'
  | 'model.configuration.read'
  | 'restorations.read'
  | 'resume.prepare';
export type RuntimeLaunchOperation = RuntimeLaunchAsyncOperation | RuntimeLaunchSyncOperation;
interface LaunchComposition {
  profile: TeamHostProfile;
  hostIncarnation: string;
  sources?: RuntimeRecipeSources;
  teams: ReadonlyMap<string, HostedTeam>;
  capturedTeams: ReadonlyMap<string, HostedTeam>;
  launches: ReadonlyMap<string, TeamLaunchOwner>;
  retainedLaunches: ReadonlyMap<string, { team: HostedTeam; launch: TeamLaunchOwner; entries?: MemberEntry[] }>;
  entries: ReadonlyMap<string, MemberEntry>;
  runtime: RuntimeOwner;
  modelReadiness?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget' | 'admitTeamProbeProfile'>;
  capture(teamId: string, commandId: string, raw: unknown, transfer?: CaptureModelReadinessTransfer): Promise<string>;
  hasCurrentCapture(teamId: string): boolean;
  isSealed(): boolean;
  assertCurrent(): void;
}

/** Existing finite launch cases; workspace verification precedes any native member claim. */
export function executeRuntimeLaunch(
  options: LaunchComposition,
  teamId: string,
  operation: RuntimeLaunchSyncOperation,
  commandId: string,
  raw: unknown,
  readiness?: CaptureModelReadinessTransfer | LocalModelReadinessAction
): JsonValue;
export function executeRuntimeLaunch(
  options: LaunchComposition,
  teamId: string,
  operation: RuntimeLaunchOperation,
  commandId: string,
  raw: unknown,
  readiness?: CaptureModelReadinessTransfer | LocalModelReadinessAction
): JsonValue | Promise<JsonValue>;
export function executeRuntimeLaunch(
  options: LaunchComposition,
  teamId: string,
  operation: RuntimeLaunchOperation,
  commandId: string,
  raw: unknown,
  readiness?: CaptureModelReadinessTransfer | LocalModelReadinessAction
): JsonValue | Promise<JsonValue> {
  if (options.isSealed()) throw new TeamLaunchError('hold', 'sealed');
  options.assertCurrent();
  if (readiness && (operation === 'capture' ? 'preparation' in readiness :
      operation !== 'start' || !('preparation' in readiness)))
    throw new TeamLaunchError('invalid', 'launch-readiness-operation');
  if (operation === 'model.configuration.read') {
    z.object({}).strict().parse(raw);
    const prospective = () => isUnstartedCaptureEditable({
      team: options.capturedTeams.get(teamId), launch: options.launches.get(teamId),
      retainedLaunches: options.retainedLaunches, entries: [...options.entries.values()], runtime: options.runtime,
    });
    if (options.hasCurrentCapture(teamId) && !prospective())
      return modelConfigurationFromLaunch(
        executeRuntimeLaunch(options, teamId, 'configuration.read', commandId, {})
      );
    const team = options.teams.get(teamId);
    if (!team) throw new TeamLaunchError('invalid', 'team');
    return readSavedTeamModelConfiguration({
      profile: options.profile,
      ...(options.sources ? { sources: options.sources } : {}),
      team,
      assertCurrent: () => {
        options.assertCurrent();
        if (options.isSealed()) throw new TeamLaunchError('hold', 'sealed');
      },
      assertRuntimeHistory: () => {
        if (!prospective()) throw new TeamLaunchError('hold', 'saved-model-runtime-history');
      },
    });
  }
  if (operation === 'capture') {
    return options
      .capture(teamId, commandId, raw, readiness as CaptureModelReadinessTransfer | undefined)
      .then((launchId) =>
        executeRuntimeLaunch(options, teamId, 'configuration.read', commandId, { launchId })
      );
  }
  if (operation === 'restorations.read') z.object({ launchId: id }).strict().parse(raw);
  if (
    operation === 'resume.prepare' &&
    !(raw && typeof raw === 'object' && 'launchId' in raw && typeof raw.launchId === 'string')
  )
    throw new TeamLaunchError('invalid', 'launch-id');
  const requested =
    raw && typeof raw === 'object' && !Array.isArray(raw) && 'launchId' in raw
      ? raw.launchId
      : undefined;
  if (requested !== undefined && typeof requested !== 'string')
    throw new TeamLaunchError('invalid', 'launch-id');
  const selected =
    requested === undefined
      ? { team: options.capturedTeams.get(teamId), launch: options.launches.get(teamId) }
      : options.retainedLaunches.get(runtimeDigest({ teamId, launchId: requested }));
  if (!selected?.team || !selected.launch || selected.team.definition.binding.teamId !== teamId)
    throw new TeamLaunchError('invalid', 'team');
  const { team, launch } = selected;
  const launchEntries = options.retainedLaunches.get(runtimeDigest({ teamId, launchId: team.launchId ?? team.definition.scope.runId }))?.entries
    ?? [...options.entries.values()].filter(entry => entry.team === team);
  if (operation === 'restorations.read')
    return { ...readLaunchRestorations(launch, options.runtime) };
  if (operation === 'resume.prepare')
    return {
      ...prepareLaunchResume(
        launch,
        launchEntries,
        options.runtime,
        raw
      ),
    };
  if (operation === 'start' || operation === 'retry') {
    assertCapturedRosterCurrent(team, options.profile.principalId);
    team.owner.assertExecutionAllowed(options.profile.principalId);
  }
  const originalRevision = operation === 'start'
    ? team.owner.withLaunchAuthority(options.profile.principalId, 'control', revision => revision)
    : undefined;
  const assertStartCurrent = () => {
    options.assertCurrent();
    if (options.isSealed()) throw new TeamLaunchError('hold', 'sealed');
    assertCapturedRosterCurrent(team, options.profile.principalId);
    team.owner.withLaunchAuthority(options.profile.principalId, 'control', revision => {
      if (revision !== originalRevision) throw new TeamLaunchError('forbidden', 'launch-authority');
    });
    team.owner.assertExecutionAllowed(options.profile.principalId);
  };
  const isStartCurrent = () => { try { assertStartCurrent(); return true; } catch { return false; } };
  let action: ReturnType<typeof captureActionModelReadiness> | undefined;
  let initialAdmission = false;
  const actorDigest = runtimeDigest({ principalId: options.profile.principalId, revision: originalRevision });
  const pendingOpenCode = operation === 'start' ? (() => {
    const summary = launch.read();
    const eligible = new Set(launch.readModelProbeSelection('read').memberIds);
    return launchEntries.filter(entry => eligible.has(entry.profile.memberId) && entry.profile.provider === 'opencode' &&
      summary.members.some(row => row.memberId === entry.profile.memberId &&
        runtimeDigest(row.binding) === runtimeDigest(entry.binding) &&
        row.attempt.status !== 'skipped' && !row.attempt.claimed));
  })() : [];
  if (pendingOpenCode.length && readiness && 'preparation' in readiness) {
    if (!options.modelReadiness) throw new TeamLaunchError('hold', 'launch-readiness-required');
    const configuration = raw && typeof raw === 'object' && 'configuration' in raw && raw.configuration !== undefined
      ? launchConfigurationSchema.parse(raw.configuration) : undefined;
    const targets = pendingOpenCode.map(entry => {
      const selected = configuration?.members.find(row => row.memberId === entry.profile.memberId);
      const profile = selected ? applyLaunchConfiguration(entry.baseProfile,
        Object.fromEntries(Object.entries(selected).filter(([name]) => name !== 'memberId'))) : structuredClone(entry.profile);
      profile.generation = entry.profile.generation;
      return { entry, profile, binding: entry.binding };
    });
    action = captureActionModelReadiness({ management: options.modelReadiness, launch, targets,
      commandId, payload: raw, actorDigest, readiness, assertCurrent: assertStartCurrent });
  } else if (pendingOpenCode.length && !readiness && pendingOpenCode.every(entry =>
      entry.initialModelAdmission !== undefined && entry.selection === undefined)) {
    attachInitialRuntimeModelAdmission({ launch, entries: pendingOpenCode, method: 'team.launch.start',
      teamId, commandId, payload: raw, actorDigest, hostIncarnation: options.hostIncarnation,
      captureReference: capturePreparedModelReference,
      ...(options.modelReadiness ? { management: options.modelReadiness } : {}), assertCurrent: assertStartCurrent });
    initialAdmission = true;
  }
  const retryMembers =
    operation === 'retry'
      ? z
          .object({
            launchId: id,
            rosterRevision: id,
            attemptId: id,
            memberIds: z.array(id).min(1).max(256),
          })
          .strict()
          .parse(raw).memberIds
      : undefined;
  // An occurrence may replace the initial task or request bootstrap only. The
  // existing launch owner persists and compares this intent before beforeOpen.
  const initialPrompt = operation === 'start' && raw && typeof raw === 'object' &&
    'initialPrompt' in raw && raw.initialPrompt !== undefined
    ? raw.initialPrompt
    : team.definition.savedSettings?.prompt;
  const run = () =>
    executeTeamLaunch({
      launch,
      members: runtimeLaunchMembers(team, launchEntries),
      entries: launchEntries,
      operation,
      commandId,
      ...(pendingOpenCode.length ? { beforeStart: async () => {
        assertStartCurrent();
        if (initialAdmission) return;
        if (!options.modelReadiness) throw new TeamLaunchError('hold', 'launch-readiness-required');
        if (action) {
          const references = await action.prepare();
          assertStartCurrent();
          for (const entry of pendingOpenCode) {
            const reference = references.get(entry.profile.memberId);
            if (!reference) throw new TeamLaunchError('hold', 'launch-readiness-required');
            attachMemberModelReadiness({ launch, entry, reference, commandId, actorDigest,
              inputDigest: action.inputDigest, cutoff: action.cutoff });
          }
        } else await prepareCapturedLaunchReadiness({ management: options.modelReadiness, launch,
          entries: pendingOpenCode, commandId, payload: raw, principalId: options.profile.principalId,
          isCurrent: isStartCurrent });
        assertStartCurrent();
      } } : {}),
      ...(operation === 'start' &&
      team.configurationRevision &&
      typeof initialPrompt === 'string' && initialPrompt.trim()
        ? {
            beforeOpen: () => {
              const lead = team.definition.members.find((member) => member.role === 'lead');
              if (!lead) throw new TeamLaunchError('hold', 'launch-lead');
              try {
                team.connection.execute({
                  commandId: effectId('launch-prompt', team.definition.binding.teamId, commandId),
                  operation: 'message.send',
                  payload: { to: lead.name, text: initialPrompt },
                });
              } catch {
                throw new TeamLaunchError('hold', 'launch-prompt-pending');
              }
            },
          }
        : {}),
      payload:
        operation === 'read' || operation === 'configuration.read'
          ? (() => {
              z.object({ launchId: id.optional() }).strict().parse(raw);
              return {};
            })()
          : raw,
    });
  if (operation === 'start' || operation === 'retry') {
    return Promise.all(
      launchEntries
        .filter(
          (entry) =>
            !retryMembers || retryMembers.includes(entry.binding.memberId)
        )
        .map(assertRuntimeWorktree)
    ).then(() => {
      options.assertCurrent();
      if (options.isSealed()) throw new TeamLaunchError('hold', 'sealed');
      assertCapturedRosterCurrent(team, options.profile.principalId);
      team.owner.assertExecutionAllowed(options.profile.principalId);
      return run();
    });
  }
  return run();
}
