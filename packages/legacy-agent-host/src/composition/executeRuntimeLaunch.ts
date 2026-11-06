import { runtimeLaunchMembers } from './runtimeLaunchMembers.js';
import { z } from 'zod';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { effectId } from '../team/identity.js';
import { assertRuntimeWorktree } from './runtimeWorktreeCapture.js';
import { assertCapturedRosterCurrent } from './teamRoster.js';
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
  teams: ReadonlyMap<string, HostedTeam>;
  capturedTeams: ReadonlyMap<string, HostedTeam>;
  launches: ReadonlyMap<string, TeamLaunchOwner>;
  retainedLaunches: ReadonlyMap<string, { team: HostedTeam; launch: TeamLaunchOwner; entries?: MemberEntry[] }>;
  entries: ReadonlyMap<string, MemberEntry>;
  runtime: RuntimeOwner;
  capture(teamId: string, commandId: string, raw: unknown): Promise<string>;
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
  raw: unknown
): JsonValue;
export function executeRuntimeLaunch(
  options: LaunchComposition,
  teamId: string,
  operation: RuntimeLaunchOperation,
  commandId: string,
  raw: unknown
): JsonValue | Promise<JsonValue>;
export function executeRuntimeLaunch(
  options: LaunchComposition,
  teamId: string,
  operation: RuntimeLaunchOperation,
  commandId: string,
  raw: unknown
): JsonValue | Promise<JsonValue> {
  if (options.isSealed()) throw new TeamLaunchError('hold', 'sealed');
  options.assertCurrent();
  if (operation === 'model.configuration.read') {
    z.object({}).strict().parse(raw);
    if (options.hasCurrentCapture(teamId))
      return modelConfigurationFromLaunch(
        executeRuntimeLaunch(options, teamId, 'configuration.read', commandId, {})
      );
    const team = options.teams.get(teamId);
    if (!team) throw new TeamLaunchError('invalid', 'team');
    return readSavedTeamModelConfiguration({
      profile: options.profile,
      team,
      assertCurrent: () => {
        options.assertCurrent();
        if (options.isSealed()) throw new TeamLaunchError('hold', 'sealed');
      },
    });
  }
  if (operation === 'capture') {
    return options
      .capture(teamId, commandId, raw)
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
  const run = () =>
    executeTeamLaunch({
      launch,
      members: runtimeLaunchMembers(team, launchEntries),
      entries: launchEntries,
      operation,
      commandId,
      ...(operation === 'start' &&
      team.configurationRevision &&
      team.definition.savedSettings?.prompt?.trim()
        ? {
            beforeOpen: () => {
              const lead = team.definition.members.find((member) => member.role === 'lead');
              if (!lead) throw new TeamLaunchError('hold', 'launch-lead');
              try {
                team.connection.execute({
                  commandId: effectId('launch-prompt', team.definition.binding.teamId, commandId),
                  operation: 'message.send',
                  payload: { to: lead.name, text: team.definition.savedSettings!.prompt! },
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
