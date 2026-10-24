import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createHostCrossTeamOutbox } from '../adapters/cross-team/createHostCrossTeamOutbox.js';
import { CascadeGuard } from '../cross-team/CascadeGuard.js';
import { inferCrossTeamReplyMetadata } from '../cross-team/CrossTeamConversationPolicy.js';
import { createHostCrossTeamCoordinator } from '../cross-team/HostCrossTeamCoordinator.js';
import { crossTeamOutboxRecord } from '../cross-team/crossTeamRecords.js';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { memberBinding } from '../team/DeliveryRecovery.js';
import { teamRegistryScopeSchema } from '../team-registry/contracts.js';
import { createCrossTeamPairAuthority } from './CrossTeamPairAuthority.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostMethod } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { CommandReceipt, ImmutableDelivery, RuntimeMemberBinding } from '../team/contracts.js';
import type { TeamMcpCrossTeamPort } from '../mcp/nativeCrossTeamContracts.js';
import type {
  BackendCrossTeamOutbox,
  BackendCrossTeamLookup,
  CapturedCrossTeamIdentity,
  CapturedCrossTeamIntent,
  HostCrossTeamSend,
} from '../cross-team/contracts.js';

const id = z.string().min(1).max(256);
const bindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    handleId: id,
    owner: z.unknown(),
    scope: teamRegistryScopeSchema,
  })
  .strict();
const envelope = z.object({ commandId: id, binding: bindingSchema, payload: z.unknown() }).strict();
const sendSchema = z
  .object({
    target: z.object({ handleId: id }).strict(),
    fromMember: id,
    toMember: id.optional(),
    text: z.string().min(1).max(48_000),
    messageId: id,
    conversationId: id.optional(),
    replyToConversationId: id.optional(),
    timestamp: id.optional(),
    summary: z.string().max(4_000).optional(),
    actionMode: z.enum(['do', 'ask', 'delegate']).optional(),
    taskRefs: z
      .array(z.object({ taskId: id, displayId: id, team: z.enum(['source', 'target']) }).strict())
      .max(100)
      .optional(),
    chainDepth: z.number().int().min(0).max(4).optional(),
  })
  .strict();
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Same-Host routing only. Both message writers remain the original Team owners. */
export function createHostCrossTeamComposition(options: {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId'>;
  teams: ReadonlyMap<string, HostedTeam>;
  assertCurrent(): void;
  activeInputs(binding: RuntimeMemberBinding): readonly ImmutableDelivery[];
}) {
  const authority = createCrossTeamPairAuthority(options),
    outbox = createHostCrossTeamOutbox(options.profile.owner.storageRoot);
  const cascade = new CascadeGuard();
  function select(binding: z.infer<typeof bindingSchema>): HostedTeam {
    options.assertCurrent();
    const team = options.teams.get(binding.scope.teamId);
    if (
      !team ||
      digest(binding.owner) !== digest(options.profile.owner) ||
      digest(binding.scope) !== digest(team.definition.scope)
    )
      throw new TeamOwnerError('forbidden');
    return team;
  }
  function targetPort(original: CapturedCrossTeamIdentity['target']) {
    const team = authority.selected(original),
      connection = team.owner.connect(original.principalId);
    const project = (receipt: CommandReceipt | undefined) => {
      if (!receipt) return undefined;
      if (!receipt.crossTeam) throw new TeamOwnerError('conflict');
      return {
        commandId: receipt.commandId,
        messageId: receipt.effects.messageId,
        authorityFingerprint: receipt.crossTeam.authorityFingerprint,
        phase: receipt.phase,
      };
    };
    return {
      lookup: (commandId: string) => project(connection.lookup(commandId)),
      receive: (intent: CapturedCrossTeamIntent) =>
        project(team.owner.receiveCrossTeam(original.principalId, intent))!,
      assertOriginal: (intent: CapturedCrossTeamIntent) => authority.assertTarget(intent),
    };
  }
  function coordinator(
    source: HostedTeam,
    principalId: string,
    guard: () => void,
    target: (request: HostCrossTeamSend) => CapturedCrossTeamIdentity['target'],
    handleId?: string
  ) {
    const commands = source.owner.crossTeamCommands(principalId);
    return createHostCrossTeamCoordinator({
      commands,
      outbox,
      cascade,
      assertCurrent: guard,
      captureOriginal(request) {
        guard();
        const originalSource = authority.source(source, principalId, handleId);
        if (request.fromMember !== originalSource.actor) throw new TeamOwnerError('forbidden');
        return {
          ownerId: options.profile.owner.ownerId,
          ownerRevision: options.profile.owner.revision,
          ownerFingerprint: authority.ownerFingerprint,
          source: originalSource,
          target: target(request),
        };
      },
      target: targetPort,
      appendSenderCopy(intent) {
        const receipt = commands.lookup(intent.commandId);
        if (!receipt) throw new TeamOwnerError('hold');
        commands.appendSenderCopy(receipt);
      },
      resolveConversation(request, pair) {
        if (request.conversationId !== undefined || request.replyToConversationId !== undefined)
          return {
            conversationId: request.conversationId ?? request.replyToConversationId!,
            ...(request.replyToConversationId === undefined
              ? {}
              : { replyToConversationId: request.replyToConversationId }),
          };
        const sender = pair.source.sender;
        const active = sender
          ? options.activeInputs({ backendId: pair.ownerId, teamId: pair.source.teamId, ...sender })
          : [];
        const hints = source.owner.readCrossTeamReplyHints(principalId, active);
        return (
          inferCrossTeamReplyMetadata(hints, pair.target.teamId) ?? { conversationId: randomUUID() }
        );
      },
    });
  }
  async function history(
    source: HostedTeam,
    principalId: string,
    guard: () => void
  ): Promise<BackendCrossTeamOutbox> {
    guard();
    const receipts = source.owner.crossTeamCommands(principalId).history();
    const rows = await outbox.read(source.definition.binding.teamName);
    guard();
    return {
      kind: 'cross-team-outbox',
      rows: rows.map((row) => {
        const matches = receipts.filter(
          (receipt) => receipt.intent.authorityFingerprint === row.authorityFingerprint
        );
        if (matches.length !== 1) throw new TeamOwnerError('hold');
        const intent = matches[0]!.intent;
        if (digest(row) !== digest(crossTeamOutboxRecord(intent))) throw new TeamOwnerError('hold');
        authority.assertPair(intent);
        const { source: from, target: to } = intent.pair;
        return {
          messageId: intent.request.messageId,
          fromTeamResourceRef: from.teamResourceRef,
          toTeamResourceRef: to.teamResourceRef,
          ...(from.handleId === undefined ? {} : { fromHandleId: from.handleId }),
          ...(to.handleId === undefined ? {} : { toHandleId: to.handleId }),
          fromTeamName: from.teamName,
          toTeamName: to.teamName,
          fromMember: from.actor,
          toMember: to.recipient.name,
          conversationId: intent.request.conversationId,
          text: intent.request.text,
          timestamp: intent.timestamp,
          chainDepth: intent.request.chainDepth ?? 0,
          ...(intent.request.replyToConversationId === undefined
            ? {}
            : { replyToConversationId: intent.request.replyToConversationId }),
          ...(intent.request.summary === undefined ? {} : { summary: intent.request.summary }),
          ...(intent.request.taskRefs === undefined
            ? {}
            : { taskRefs: structuredClone(intent.request.taskRefs) }),
        };
      }),
    };
  }
  function lookup(
    source: HostedTeam,
    principalId: string,
    commandId: string,
    guard: () => void
  ): BackendCrossTeamLookup {
    const original = coordinator(source, principalId, guard, () => {
      throw new TeamOwnerError('hold');
    }).lookup(commandId);
    if (!original) return { kind: 'cross-team-lookup', commandId, phase: 'absent' };
    const intent = original.source.intent;
    return {
      kind: 'cross-team-lookup',
      commandId,
      messageId: intent.request.messageId,
      conversationId: intent.request.conversationId,
      toMember: intent.pair.target.recipient.name,
      phase:
        original.source.phase === 'completed'
          ? 'completed'
          : original.target && ['held', 'rejected'].includes(original.target.phase)
            ? 'held'
            : 'prepared',
    };
  }
  const methods: Record<string, HostMethod> = {};
  for (const operation of ['send', 'lookup', 'outbox.read'] as const)
    methods['team.crossTeam.' + operation] = {
      lane: operation === 'send' ? 'work' : 'control',
      async handle(raw): Promise<JsonValue> {
        try {
          options.assertCurrent();
          const input = envelope.parse(raw),
            source = select(input.binding);
          if (operation === 'outbox.read') {
            z.object({}).strict().parse(input.payload);
            return {
              ok: true,
              value: json(
                await history(source, options.profile.principalId, options.assertCurrent)
              ),
            };
          }
          if (operation === 'lookup') {
            z.object({}).strict().parse(input.payload);
            return {
              ok: true,
              value: json(
                lookup(source, options.profile.principalId, input.commandId, options.assertCurrent)
              ),
            };
          }
          const paired = z
            .object({ request: sendSchema, targetBinding: bindingSchema })
            .strict()
            .parse(input.payload);
          const target = select(paired.targetBinding);
          if (paired.request.target.handleId !== paired.targetBinding.handleId || source === target)
            throw new TeamOwnerError('forbidden');
          const request = JSON.parse(JSON.stringify(paired.request)) as HostCrossTeamSend;
          const service = coordinator(
            source,
            options.profile.principalId,
            options.assertCurrent,
            () =>
              authority.target(
                target,
                options.profile.principalId,
                request.toMember,
                paired.targetBinding.handleId
              ),
            input.binding.handleId
          );
          return {
            ok: true,
            value: json(await service.send(input.commandId, digest(request), request)),
          };
        } catch (error) {
          const code =
            error instanceof TeamOwnerError
              ? error.code
              : error instanceof z.ZodError
                ? 'invalid'
                : 'hold';
          return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
        }
      },
    };
  function memberPort(
    source: HostedTeam,
    principalId: string,
    binding: RuntimeMemberBinding,
    isCurrent: () => boolean
  ): TeamMcpCrossTeamPort {
    const captured = structuredClone(binding);
    const guard = () => {
      options.assertCurrent();
      if (
        !isCurrent() ||
        options.teams.get(source.definition.binding.teamId) !== source ||
        !source.owner.authorizeRuntimeAccess(principalId, captured, 'read')
      )
        throw new TeamOwnerError('forbidden');
      const actor = source.owner.crossTeamIdentity(principalId);
      const member = actor.members.find((row) => row.name === actor.actor);
      if (
        !member?.delivery ||
        digest(memberBinding(member.delivery)) !== digest(memberBinding(captured))
      )
        throw new TeamOwnerError('forbidden');
    };
    const hint = (teamName?: string) => {
      guard();
      if (teamName !== undefined && teamName !== source.definition.binding.teamName)
        throw new TeamOwnerError('forbidden');
    };
    const catalog = () => {
      guard();
      return [...options.teams.values()]
        .filter((team) => team !== source)
        .flatMap((team) => {
          try {
            return [{ team, side: authority.target(team, options.profile.principalId) }];
          } catch {
            return [];
          }
        });
    };
    return {
      listTargets(input) {
        hint(input?.teamName);
        return catalog()
          .filter(
            (row) =>
              input?.excludeTeam !== row.side.resourceRef &&
              input?.excludeTeam !== row.side.teamName
          )
          .map(({ side }) => ({
            resourceRef: side.resourceRef,
            teamResourceRef: side.teamResourceRef,
            teamName: side.teamName,
            recipientName: side.recipient.name,
          }));
      },
      async send(raw) {
        hint(raw.teamName);
        const input = structuredClone(raw),
          actor = source.owner.crossTeamIdentity(principalId).actor;
        if (input.fromMember !== undefined && input.fromMember !== actor)
          throw new TeamOwnerError('forbidden');
        const old = source.owner.crossTeamCommands(principalId).lookup(input.commandId);
        const selected = old
          ? { side: old.intent.pair.target }
          : catalog().find((row) => row.side.resourceRef === input.toTeam);
        if (!selected) throw new TeamOwnerError('hold');
        const taskRefs = input.taskRefs?.map((ref) => {
          const team: 'source' | 'target' | undefined =
            ref.teamName === source.definition.binding.teamName
              ? 'source'
              : ref.teamName === selected.side.teamName
                ? 'target'
                : undefined;
          if (!team) throw new TeamOwnerError('invalid');
          return { taskId: ref.taskId, displayId: ref.displayId, team };
        });
        const request: HostCrossTeamSend = {
          target: { resourceRef: input.toTeam },
          fromMember: actor,
          messageId: input.commandId,
          text: input.text,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.replyToConversationId === undefined
            ? {}
            : { replyToConversationId: input.replyToConversationId }),
          ...(input.chainDepth === undefined ? {} : { chainDepth: input.chainDepth }),
          ...(taskRefs === undefined ? {} : { taskRefs }),
        };
        const service = coordinator(source, principalId, guard, () => {
          const chosen = catalog().find((row) => row.side.resourceRef === input.toTeam);
          if (!chosen) throw new TeamOwnerError('hold');
          return chosen.side;
        });
        return service.send(input.commandId, digest(json(input)), request);
      },
      lookup(commandId) {
        guard();
        return lookup(source, principalId, commandId, guard);
      },
      getOutbox(input) {
        hint(input?.teamName);
        return history(source, principalId, guard);
      },
    };
  }
  return { methods, sourceAuthorized: authority.sourceAuthorized, memberPort };
}
