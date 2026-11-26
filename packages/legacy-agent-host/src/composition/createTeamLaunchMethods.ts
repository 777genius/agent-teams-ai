import { z } from 'zod';
import { parsePreparationEnvelope, selectBoundHostTeam, json } from './teamHostEnvelope.js';
import { executeTeamModelProbe } from './teamLaunchModelProbe.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import type { HostMethod } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { TeamHostProfile } from './teamHostProfile.js';
import type { HostedTeam, RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { HostTeamProjectContexts } from '../team-project-context/HostTeamProjectContexts.js';

/** Captured launch and original model-readiness routes share the project admission gate. */
export function createTeamLaunchMethods(options: {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId'>; teams: ReadonlyMap<string, HostedTeam>;
  runtime?: RuntimeTeamCoordinator; management?: ProviderManagementCoordinator;
  contexts: HostTeamProjectContexts; assertCurrent(): void;
}): Record<string, HostMethod> {
  const { profile, teams, runtime, management, contexts, assertCurrent } = options;
  const launchMethods: Record<string, HostMethod> = {};
  for (const operation of [
    'capture',
    'start',
    'read',
    'retry',
    'configuration.read',
    'model.configuration.read',
    'restorations.read',
    'resume.prepare',
  ] as const) {
    launchMethods[`team.launch.${operation}`] = {
      lane:
        operation === 'read' ||
        operation === 'configuration.read' ||
        operation === 'model.configuration.read' ||
        operation === 'restorations.read' ||
        operation === 'resume.prepare'
          ? 'control'
          : 'work',
      async handle(raw): Promise<JsonValue> {
        try {
          assertCurrent();
          const input = parsePreparationEnvelope(raw, `team.launch.${operation}`),
            selected = selectBoundHostTeam(input, profile.owner, teams);
          if (!selected) throw new TeamLaunchError('forbidden', 'binding');
          if (operation === 'model.configuration.read' && runtime)
            return {
              ok: true,
              value: await runtime.executeLaunch(
                selected.definition.binding.teamId,
                operation,
                input.commandId,
                input.payload
              ),
            };
          if (
            !runtime ||
            !teams.has(selected.definition.binding.teamId) ||
            ((operation === 'read' || operation === 'configuration.read') &&
              !runtime.hasCurrentCapture(selected.definition.binding.teamId) &&
              !(
                input.payload &&
                typeof input.payload === 'object' &&
                'launchId' in input.payload
              ))
          ) {
            if (operation !== 'read' && operation !== 'configuration.read')
              throw new TeamLaunchError('invalid', 'runtime-unconfigured');
            z.object({}).strict().parse(input.payload);
            return selected.owner.withLaunchAuthority(profile.principalId, 'read', () => ({
              ok: true,
              value: null,
            }));
          }
          return {
            ok: true,
            value: await (['capture', 'start', 'retry'].includes(operation)
              ? contexts.withLaunch({ team: selected, handleId: input.binding.handleId }, async () => runtime!.executeLaunch(
              selected.definition.binding.teamId,
              operation,
              input.commandId,
              input.payload,
              (input.localModelReadinessTransfer ? contexts.captureReadinessTransfer(
                { team: selected, handleId: input.binding.handleId }, input.localModelReadinessTransfer) : undefined) ?? (input.localModelReadinessOrigin ? {
                preparation: input.localModelReadinessOrigin, owner: profile.owner,
                handleId: input.binding.handleId, scope: input.binding.scope,
              } : undefined)
            )) : runtime.executeLaunch(selected.definition.binding.teamId, operation, input.commandId, input.payload)),
            ...(input.localModelReadinessCapture ? { localModelReadinessCapture: json(
              runtime.readModelReadinessCapture(selected.definition.binding.teamId, input.localModelReadinessCapture)) } : {}),
          };
        } catch (error) {
          const code =
            error instanceof TeamLaunchError ||
            error instanceof TeamOwnerError ||
            error instanceof RuntimeOwnerError
              ? error.code
              : error instanceof z.ZodError
                ? 'invalid'
                : 'hold';
          return {
            ok: false,
            code,
            outcome: code === 'hold' ? 'unknown' : 'rejected',
            ...(error instanceof TeamLaunchError ? { reason: error.reason } : {}),
          };
        }
      },
    };
  }

  if (runtime && management)
    for (const action of ['start', 'read', 'cancel'] as const) {
      launchMethods[`team.launch.probe.${action}`] = {
        lane: action === 'start' ? 'work' : 'control',
        async handle(raw): Promise<JsonValue> {
          try {
            assertCurrent();
            const input = parsePreparationEnvelope(raw, `team.launch.probe.${action}`),
              selected = selectBoundHostTeam(input, profile.owner, teams);
            if (!selected) throw new TeamLaunchError('forbidden', 'binding');
            return {
              ok: true,
              value: json(
                await executeTeamModelProbe({
                  runtime: runtime!,
                  management: management!,
                  action,
                  teamId: selected.definition.binding.teamId,
                  commandId: input.commandId,
                  payload: input.payload,
                  ...(input.localModelReadinessOrigin ? { readiness: {
                    preparation: input.localModelReadinessOrigin, owner: profile.owner,
                    handleId: input.binding.handleId, scope: input.binding.scope,
                  } } : {}),
                })
              ),
            };
          } catch (error) {
            const code =
              error instanceof TeamLaunchError ||
              error instanceof TeamOwnerError ||
              error instanceof ManagementCommandError
                ? error.code === 'held'
                  ? 'hold'
                  : error.code
                : error instanceof z.ZodError
                  ? 'invalid'
                  : 'hold';
            return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
          }
        },
      };
    }
  return launchMethods;
}
