import { groupReactionTargetSchema, parseGroupPayload } from './operations.js';
import { TeamOwnerError } from '../team/contracts.js';
import { teamCommandPath, validateCommandEntry } from '../team/commandEntries.js';
import { digest } from '../team/identity.js';
import { createTeamGroupChatsFeature } from './createTeamGroupChatsFeature.js';
import {
  groupMutationSchema,
  groupReceiptFingerprint,
  validateGroupCommandReceipt,
} from './groupCommandRecords.js';
import type {
  GroupMutation,
  GroupCommandReceipt,
  CapturedGroupIntent,
} from './groupCommandRecords.js';
import type { GroupChatStorage } from './storage.js';
import type { TeamGroupChatsPorts } from './createTeamGroupChatsFeature.js';
import type { TeamStore } from '../team/ports.js';
import type { TeamBinding, TeamGrant, CommandReceipt } from '../team/contracts.js';
import type { JsonValue } from '../contracts.js';
export interface GroupCommandContext {
  binding: TeamBinding;
  principalId: string;
  store: TeamStore;
  authorize(write: boolean): TeamGrant;
  reserved(id: string): boolean;
  storage(guard: GroupRequestGuard): GroupChatStorage;
  rosterFingerprint(): string;
  ports(guard: () => void): TeamGroupChatsPorts;
  receive(intent: CapturedGroupIntent): CommandReceipt;
}
export interface GroupRequestGuard {
  before(): void;
  inside(): void;
  publish?(): void;
}
/** Existing group application, wrapped by Team's original command namespace and authority. */
export function createGroupCommands(options: GroupCommandContext) {
  const read = (id: string) => {
    const raw = options.store.read<GroupCommandReceipt>(teamCommandPath(id));
    if (!raw) return undefined;
    const entry = validateCommandEntry(raw);
    if (!('family' in entry) || entry.family !== 'group-chat') throw new TeamOwnerError('conflict');
    if (entry.principalId !== options.principalId) throw new TeamOwnerError('forbidden');
    if (digest(entry.binding) !== digest(options.binding)) throw new TeamOwnerError('hold');
    return entry;
  };
  function current(revision: number, write = true) {
    const grant = options.authorize(write);
    if ((grant.revision ?? 1) !== revision) throw new TeamOwnerError('forbidden');
    return grant;
  }
  function project(receipt: GroupCommandReceipt | undefined, commandId: string) {
    return receipt
      ? {
          kind: 'group-chat-command' as const,
          commandId,
          phase: receipt.phase,
          operation: receipt.request.operation,
          ...(receipt.phase === 'completed' ? { result: receipt.response } : {}),
        }
      : { kind: 'group-chat-command' as const, commandId, phase: 'absent' as const };
  }
  return {
    lookup(commandId: string) {
      return options.store.fenced(() => {
        options.authorize(false);
        return project(read(commandId), commandId);
      });
    },
    async read(
      operation: 'list' | 'reaction.read',
      payload: unknown,
      authority: GroupRequestGuard
    ) {
      const grant = options.store.fenced(() => options.authorize(false));
      const revision = grant.revision ?? 1;
      if (operation === 'list') parseGroupPayload('group.list', payload);
      const inside = () => {
        authority.inside();
        current(revision, false);
      };
      const guard = () => {
        authority.before();
        options.store.fenced(inside);
      };
      guard();
      const service = createTeamGroupChatsFeature(
        options.ports(guard),
        options.storage({ before: guard, inside })
      );
      const result =
        operation === 'list'
          ? await service.list({ teamName: options.binding.teamName }, grant.memberName)
          : await service.getReaction({
              ...groupReactionTargetSchema.parse(payload),
              teamName: options.binding.teamName,
            });
      guard();
      return result;
    },
    async execute(commandId: string, raw: unknown, authority: GroupRequestGuard) {
      const request = groupMutationSchema.parse(raw);
      // A single original command is serialized, including its fanout. No implicit effect replay.
      const lock = options.storage(authority);
      return lock.logicalPost(`group-command:${commandId}`, async () => {
        authority.before();
        const receipt = options.store.fenced(() => {
          authority.inside();
          const grant = options.authorize(true),
            previous = read(commandId);
          if (options.reserved(commandId)) throw new TeamOwnerError('conflict');
          const actor = grant.memberName;
          if (
            (actor === 'user' && ['create.agent', 'reaction.ack'].includes(request.operation)) ||
            (actor !== 'user' && ['create', 'archive', 'reaction.set'].includes(request.operation))
          )
            throw new TeamOwnerError('forbidden');
          if (previous) {
            if (digest(previous.request) !== digest(request) || previous.actor !== actor)
              throw new TeamOwnerError('conflict');
            current(previous.authorityRevision);
            return previous;
          }
          const prepared: GroupCommandReceipt = {
            schemaVersion: 1,
            family: 'group-chat',
            binding: options.binding,
            commandId,
            principalId: options.principalId,
            actor,
            authorityRevision: grant.revision ?? 1,
            request,
            createdAt: new Date().toISOString(),
            phase: 'prepared',
            publication: 'not-requested',
            deliveries: [],
            fingerprint: '',
          };
          prepared.fingerprint = groupReceiptFingerprint(prepared);
          validateGroupCommandReceipt(prepared);
          options.store.write(teamCommandPath(commandId), prepared);
          return prepared;
        });
        if (receipt.phase === 'completed') return project(receipt, commandId);
        if (receipt.publication === 'requested')
          return project({ ...receipt, phase: 'held' }, commandId);
        const rosterFingerprint = options.store.fenced(options.rosterFingerprint);
        const inside = () => {
          authority.inside();
          current(receipt.authorityRevision);
          if (
            read(commandId)?.fingerprint !== receipt.fingerprint ||
            options.rosterFingerprint() !== rosterFingerprint
          )
            throw new TeamOwnerError('hold');
        };
        const guard = () => {
          authority.before();
          options.store.fenced(inside);
        };
        const publish = () => {
          inside();
          const saved = read(commandId)!;
          if (saved.publication !== 'requested') {
            saved.publication = 'requested';
            validateGroupCommandReceipt(saved);
            options.store.write(teamCommandPath(commandId), saved);
          }
        };
        const ports = options.ports(guard);
        ports.deliver = async (_teamName, message, run, shouldStillWrite) => {
          guard();
          const intent: CapturedGroupIntent = {
            binding: options.binding,
            sourceCommandId: commandId,
            sourceFingerprint: receipt.fingerprint,
            principalId: options.principalId,
            actor: receipt.actor,
            authorityRevision: receipt.authorityRevision,
            recipient: {
              name: message.to,
              physicalMessageId: message.messageId,
              commandId: message.messageId,
              binding: deliveryBinding(run),
            },
            message,
          };
          options.store.fenced(() => {
            inside();
            const saved = read(commandId)!;
            const previous = saved.deliveries.find((row) => row.recipient.name === message.to);
            const capture = { recipient: intent.recipient, messageDigest: digest(message) };
            if (previous && digest(previous) !== digest(capture)) throw new TeamOwnerError('hold');
            if (!previous) {
              saved.deliveries.push(capture);
              validateGroupCommandReceipt(saved);
              options.store.write(teamCommandPath(commandId), saved);
            }
          });
          if (!(await shouldStillWrite())) return 'skipped';
          guard();
          return options.store.fenced(() => {
            inside();
            const delivered = options.receive(intent);
            return delivered.phase === 'completed'
              ? 'queued'
              : delivered.phase === 'rejected'
                ? 'failed'
                : 'unknown';
          });
        };
        const service = createTeamGroupChatsFeature(
          ports,
          options.storage({ before: guard, inside, publish })
        );
        try {
          const response = await apply(service, request, options.binding.teamName, receipt.actor);
          guard();
          return options.store.fenced(() => {
            inside();
            const saved = read(commandId)!;
            saved.phase = 'completed';
            saved.response = JSON.parse(JSON.stringify(response)) as JsonValue;
            validateGroupCommandReceipt(saved);
            options.store.write(teamCommandPath(commandId), saved);
            return project(saved, commandId);
          });
        } catch (error) {
          options.store.fenced(() => {
            const saved = read(commandId);
            if (saved?.phase === 'prepared') {
              saved.phase = 'held';
              validateGroupCommandReceipt(saved);
              options.store.write(teamCommandPath(commandId), saved);
            }
          });
          throw error;
        }
      });
    },
  };
}
import type { GroupChatRun, TeamGroupChatsFeature } from './createTeamGroupChatsFeature.js';
import type { DeliveryBinding } from '../team/contracts.js';
export interface HostGroupRun extends GroupChatRun {
  binding: DeliveryBinding;
}
function deliveryBinding(run: GroupChatRun): DeliveryBinding {
  if (!('binding' in run) || run.provider !== 'host') throw new TeamOwnerError('hold');
  return structuredClone((run as HostGroupRun).binding);
}
async function apply(
  service: TeamGroupChatsFeature,
  request: GroupMutation,
  teamName: string,
  actor: string
) {
  switch (request.operation) {
    case 'create': {
      const { operation: _operation, ...payload } = request;
      return service.create({ ...payload, teamName });
    }
    case 'create.agent':
      return service.createFromAgent({
        teamName,
        from: actor,
        sourceMessageId: request.sourceMessageId,
        name: request.name,
        selectedMemberNames: request.selectedMemberNames,
        ...(request.autoIncludeNewMembers === undefined
          ? {}
          : { autoIncludeNewMembers: request.autoIncludeNewMembers }),
      });
    case 'archive':
      return service.setArchived({
        teamName,
        groupChatId: request.groupChatId,
        archived: request.archived,
      });
    case 'send':
      return service.send(
        {
          teamName,
          groupChatId: request.groupChatId,
          messageId: request.messageId,
          text: request.text,
          ...(request.recipientName === undefined ? {} : { recipientName: request.recipientName }),
          ...(request.summary === undefined ? {} : { summary: request.summary }),
          ...(request.taskRefs === undefined ? {} : { taskRefs: request.taskRefs }),
          ...(request.relayOfMessageId === undefined
            ? {}
            : { relayOfMessageId: request.relayOfMessageId }),
        },
        actor
      );
    case 'reaction.set':
      return service.setReaction({
        teamName,
        groupChatId: request.groupChatId,
        messageId: request.messageId,
        active: request.active,
      });
    case 'reaction.ack':
      return service.react({
        teamName,
        groupChatId: request.groupChatId,
        relayOfMessageId: request.relayOfMessageId,
        from: actor,
      });
  }
}
