import { nativeAdditionDefinition } from '../team-launch/nativeLaunchAddition.js';
import { applyUnconfiguredMemberSelections } from '../team-launch/applyUnconfiguredMemberSelections.js';
import type { ActionLaunchRecord } from '../team-launch/memberActions.js';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import { initialContextDigest } from '../team-launch/context.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { HostedTeam } from './RuntimeTeamCoordinator.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { RuntimeLaunchPort } from '../team-launch/contracts.js';

export function memberInitialInstructions(
  name: string,
  role: string,
  teamName: string,
  cwd: string
): string {
  return `You are ${name}, ${role} of team ${teamName}. Work in ${cwd}. Use the team MCP tools for shared tasks and messages. Native conversation completion does not complete a shared task. Supply stable commandId values for mutations.`;
}

/** Static descriptor roster only. Future dynamic UI membership is a separate explicit intent. */
export function createCapturedTeamLaunch(options: {
  root: string;
  team: HostedTeam;
  principalId: string;
  hostIncarnation: string;
  members: {
    memberId: string;
    binding: RuntimeBinding;
    configurationDigest: string;
    instructions: string;
    configRevision: string;
    timeoutMs: number;
    runtimeGeneration: number;
    baseConfigurationDigest: string;
    restore?: import('../team-launch/contracts.js').ExpectedLaunchMember['restore'];
  }[];
  runtime: RuntimeLaunchPort;
  onProgress(): void;
}): TeamLaunchOwner {
  const definition = options.team.definition;
  const members = definition.members.map((member) => {
    const configured = options.members.find((item) => item.memberId === member.memberId);
    const delivery = member.delivery;
    return {
      memberId: member.memberId,
      binding:
        configured?.binding ??
        (delivery
          ? {
              backendId: delivery.backendId,
              teamId: delivery.teamId,
              runId: delivery.runId,
              memberId: delivery.memberId,
              generation: delivery.generation,
            }
          : null),
      configurationDigest: configured?.configurationDigest ?? null,
      contextDigest: configured ? initialContextDigest(configured.instructions) : null,
      configRevision: configured?.configRevision ?? null,
      skipped: member.launchPolicy === 'skip',
      timeoutMs: configured?.timeoutMs ?? 30_000,
      ...(configured
        ? {
            runtimeGeneration: configured.runtimeGeneration,
            baseConfigurationDigest: configured.baseConfigurationDigest,
            ...(configured.restore ? { restore: configured.restore } : {}),
          }
        : {}),
    };
  });
  const store = new TeamOwnerStore(options.root, definition.binding.teamName);
  const boundedStore = {
    fenced: <T>(callback: () => T) => store.fenced(callback),
    read: <T>(name: string): T | undefined => {
      try {
        const stat = lstatSync(join(store.directory, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
          throw new TeamLaunchError('hold', 'record-budget');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return store.read<T>(name);
    },
    write: (name: string, value: unknown) => store.write(name, value),
  };
  const original = boundedStore.read<ActionLaunchRecord>(`launches/${runtimeDigest(options.team.launchId ?? definition.scope.runId)}.json`);
  const preparedDefinition = applyUnconfiguredMemberSelections(
      {
        launchId: options.team.launchId ?? definition.scope.runId,
        rosterRevision: runtimeDigest({ scope: definition.scope, members }),
        rosterScope: definition.scope,
        ...(options.team.capture === undefined ? {} : { capture: options.team.capture }),
        members,
      },
      original
    );
  return new TeamLaunchOwner({
    definition: original?.nativeAdditions?.length ? nativeAdditionDefinition(preparedDefinition, original) : preparedDefinition,
    store: boundedStore,
    hostIncarnation: options.hostIncarnation,
    authorized: (action, callback) =>
      options.team.owner.withLaunchAuthority(options.principalId, action, callback),
    captureActor: () =>
      options.team.owner.withLaunchAuthority(
        options.principalId,
        'control',
        (authorityRevision) => ({ principalId: options.principalId, authorityRevision })
      ),
    runtime: options.runtime,
    onProgress: options.onProgress,
  });
}
