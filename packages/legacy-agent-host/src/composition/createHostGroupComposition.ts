import { z } from 'zod';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { teamRegistryScopeSchema } from '../team-registry/contracts.js';
import { GroupChatError } from '../group-chats/model.js';
import { parseGroupPayload } from '../group-chats/operations.js';
import type { HostMethod } from '../index.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { GroupChatRun } from '../group-chats/createTeamGroupChatsFeature.js';
import type { TeamMcpGroupPort } from '../mcp/groupChatTools.js';
import type { MemberInputCapture } from './createRuntimeMemberProviderFactory.js';
import type { JsonValue } from '../contracts.js';
const id = z.string().min(1).max(256);
const envelope = z.strictObject({
  commandId: id,
  payload: z.unknown(),
  binding: z.strictObject({
    schemaVersion: z.literal(1),
    handleId: id,
    owner: z.unknown(),
    scope: teamRegistryScopeSchema,
  }),
});
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
/** Main handles and native endpoints converge on the same Team-owned group application. */
export function createHostGroupComposition(options: {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId'>;
  teams: ReadonlyMap<string, HostedTeam>;
  assertCurrent(): void;
  getRun(teamId: string, memberName: string): Promise<GroupChatRun | null>;
  kick(): void;
}) {
  const commands = (team: HostedTeam, principal: string) =>
    team.owner.groupCommands(principal, {
      getRun: (memberName) => options.getRun(team.definition.binding.teamId, memberName),
      afterDelivery: options.kick,
    });
  const methods: Record<string, HostMethod> = {};
  for (const operation of [
    'list',
    'create',
    'archive',
    'send',
    'reaction.read',
    'reaction.set',
    'lookup',
  ] as const) {
    methods[`team.group.${operation}`] = {
      lane: ['list', 'reaction.read', 'lookup'].includes(operation) ? 'control' : 'work',
      async handle(raw): Promise<JsonValue> {
        try {
          options.assertCurrent();
          const input = envelope.parse(raw),
            team = options.teams.get(input.binding.scope.teamId);
          if (
            !team ||
            digest(input.binding.owner) !== digest(options.profile.owner) ||
            digest(input.binding.scope) !== digest(team.definition.scope)
          )
            throw new TeamOwnerError('forbidden');
          if (
            !['list', 'reaction.read', 'lookup'].includes(operation) &&
            team.owner.crossTeamIdentity(options.profile.principalId).actor !== 'user'
          )
            throw new TeamOwnerError('forbidden');
          const payload = parseGroupPayload(`group.${operation}`, input.payload),
            service = commands(team, options.profile.principalId);
          const guard = { before: options.assertCurrent, inside: options.assertCurrent };
          const value =
            operation === 'lookup'
              ? service.lookup(input.commandId)
              : operation === 'list' || operation === 'reaction.read'
                ? await service.read(operation, payload, guard)
                : await service.execute(input.commandId, { ...payload, operation }, guard);
          return { ok: true, value: json(value) };
        } catch (error) {
          const code =
            error instanceof TeamOwnerError
              ? error.code
              : error instanceof z.ZodError
                ? 'invalid'
                : error instanceof GroupChatError
                  ? error.code === 'storage-unavailable'
                    ? 'hold'
                    : 'invalid'
                  : 'hold';
          return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
        }
      },
    };
  }
  function member(
    entry: MemberEntry,
    capture: MemberInputCapture,
    isCurrent: () => boolean
  ): TeamMcpGroupPort {
    const team = entry.team,
      principal = entry.profile.principalId,
      teamId = entry.binding.teamId,
      backendId = entry.binding.backendId,
      canonical = options.teams.get(teamId),
      owner = team.owner,
      connection = team.connection,
      teamBinding = digest(team.definition.binding);
    const guard = () => {
      options.assertCurrent();
      if (
        !isCurrent() ||
        !canonical ||
        options.teams.get(teamId) !== canonical ||
        entry.team !== team ||
        entry.binding.teamId !== teamId ||
        entry.binding.backendId !== backendId ||
        team.definition.binding.teamId !== teamId ||
        team.definition.binding.backendId !== backendId ||
        digest(team.definition.binding) !== teamBinding ||
        digest(canonical.definition.binding) !== teamBinding ||
        team.owner !== owner ||
        canonical.owner !== owner ||
        team.connection !== connection ||
        canonical.connection !== connection
      )
        throw new TeamOwnerError('forbidden');
    };
    const service = () => commands(team, principal);
    return {
      list: () => {
        guard();
        return service().read('list', {}, { before: guard, inside: guard });
      },
      lookup: (commandId) => {
        guard();
        return service().lookup(commandId);
      },
      async execute(commandId, request) {
        guard();
        const original = capture(false);
        // Exact Team projection proves the human-owned source without exposing its receipt to the agent.
        if (request.operation === 'create.agent') {
          if (
            request.sourceMessageId !==
            team.owner.groupInputSource(principal, original.team).sourceMessageId
          )
            throw new TeamOwnerError('forbidden');
        } else if (
          request.operation === 'reaction.ack' ||
          (request.operation === 'send' && request.relayOfMessageId !== undefined)
        ) {
          const source = team.owner.groupInputSource(principal, original.team);
          if (
            request.relayOfMessageId !== source.physicalMessageId ||
            request.groupChatId !== source.groupChatId
          )
            throw new TeamOwnerError('forbidden');
        }
        return service().execute(commandId, request, {
          before: () => {
            guard();
            original.assertCurrent();
          },
          inside: () => {
            guard();
            original.assertTeamCurrent();
          },
        });
      },
    };
  }
  return { methods, member };
}
