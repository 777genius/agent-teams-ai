import { HostTeamProjectContexts } from '../team-project-context/HostTeamProjectContexts.js';
import { HostProjectDefinitionEdits } from '../team-project-context/HostProjectDefinitionEdits.js';
import { TeamOwnerError } from '../team/contracts.js';
import { replaceRosterPayloadSchema } from '../team/rosterSchema.js';
import { createHostProjectReviewFlowComposition } from './createHostProjectReviewFlowComposition.js';
import { parsePreparationEnvelope, selectBoundHostTeam, json } from './teamHostEnvelope.js';
import type { HostMethod } from '../index.js';
import type { TeamHostProfile } from './teamHostProfile.js';
import type { HostedTeam, RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';
import type { TeamRegistry } from '../team-registry/TeamRegistry.js';
import type { TeamStore } from '../team/ports.js';
import type { OwnerState } from '../team/ownerState.js';

/** One original owner, registry and control lane for project definitions and their histories. */
export function createHostProjectContextComposition(options: {
  profile: TeamHostProfile;
  teams: Map<string, HostedTeam>;
  stores: ReadonlyMap<string, TeamStore>;
  registry?: TeamRegistry;
  runtime(): RuntimeTeamCoordinator | undefined;
  assertCurrent(): void;
}) {
  const { profile } = options;
  // Static shared fixtures may predate creation contexts. Only the captured profile grants this
  // empty catalog; exceptions from an authorized registry remain visible and never become fallback.
  const registry: Pick<TeamRegistry, 'list' | 'lookup' | 'createProjectContext'> = {
    list(contextId) {
      options.assertCurrent();
      if (!options.registry || !profile.creation?.contextIds.includes(contextId)) return { teams: [], held: [] };
      return options.registry.list(contextId);
    },
    lookup(...args) {
      if (!options.registry) throw new TeamOwnerError('forbidden');
      return options.registry.lookup(...args);
    },
    createProjectContext(...args) {
      if (!options.registry) throw new TeamOwnerError('forbidden');
      return options.registry.createProjectContext(...args);
    },
  };
  const assertStopped = (team: HostedTeam) => {
    options.assertCurrent();
    team.connection.readRoster();
    const state = options.stores.get(team.definition.binding.teamId)?.read<OwnerState>('state.json'), runtime = options.runtime();
    if (!state) throw new TeamOwnerError('hold');
    if (runtime) runtime.assertRosterEditable(team.definition.binding.teamId, state.members);
    else if (state.members.some(member => member.delivery)) throw new TeamOwnerError('hold');
  };
  const review = createHostProjectReviewFlowComposition({ ...options, registry: () => registry });
  const contexts = new HostTeamProjectContexts({
    principalId: profile.principalId, registry,
    team: teamId => options.teams.get(teamId),
    store(team) {
      const store = options.stores.get(team.definition.binding.teamId);
      if (!store) throw new TeamOwnerError('hold');
      return store;
    },
    assertCurrent: options.assertCurrent, assertStopped,
    synchronizeHistory: review.synchronizeHistory,
    reconcileDefinition: target => definitions.reconcileStopped(target),
  });
  const definitions = new HostProjectDefinitionEdits({
    ...options, principalId: profile.principalId, registry: () => registry, assertStopped,
    assertNotLaunching: target => contexts.assertDefinitionAdmission(target),
    async executeLive(input) {
      const runtime = options.runtime();
      if (runtime) return runtime.executeLiveRoster(input);
      if (input.conversation.phase === 'continue') throw new TeamOwnerError('hold');
      const team = options.teams.get(input.teamId);
      if (!team) throw new TeamOwnerError('forbidden');
      if (input.conversation.phase === 'read') return { ok: true,
        value: team.connection.lookupRoster(input.commandId, (input.payload as { expected: never }).expected) ?? null };
      return { ok: true, value: team.connection.replaceRoster({ ...replaceRosterPayloadSchema.parse(input.payload), commandId: input.commandId }) };
    },
  });
  const methods: Record<string, HostMethod> = {};
  for (const action of ['read', 'prepare', 'launch-source.read'] as const) {
    const operation = `team.project-context.${action}`;
    methods[operation] = {
      lane: action === 'prepare' ? 'work' : 'control',
      handle(raw) {
        try {
          options.assertCurrent();
          const input = parsePreparationEnvelope(raw, operation);
          const team = selectBoundHostTeam(input, profile.owner, options.teams);
          if (!team) throw new TeamOwnerError('forbidden');
          const target = { team, handleId: input.binding.handleId };
          const value = action === 'read' ? contexts.read(target, input.payload)
            : action === 'prepare' ? contexts.prepare(target, input.commandId, input.payload)
              : contexts.readLaunchSource(target, input.payload);
          return { ok: true, value: json(value) };
        } catch (error) {
          const code = error instanceof TeamOwnerError ? error.code : 'hold';
          return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
        }
      },
    };
  }
  return { contexts, definitions, review, registry, methods };
}
