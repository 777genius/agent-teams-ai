import type { GroupRequestGuard } from './GroupCommands.js';
import { createGroupCommands } from './GroupCommands.js';
import { GroupChatError } from './model.js';
import { digest } from '../team/identity.js';
import { listProductCommandReceipts, listTeamCommandEntries } from '../team/commandEntries.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { GroupChatStorage } from './storage.js';
import type { GroupChatRun } from './createTeamGroupChatsFeature.js';
import type { CapturedGroupIntent, GroupCommandReceipt } from './groupCommandRecords.js';
import type { TeamStore } from '../team/ports.js';
import type { TeamBinding, TeamGrant, TeamMember, CommandReceipt } from '../team/contracts.js';
export interface GroupRuntimeAccess {
  getRun(memberName: string): Promise<GroupChatRun | null>;
  afterDelivery?(): void;
}
export type GroupStorageFactory = (
  guard: GroupRequestGuard,
  humanOriginal: (row: Record<string, unknown>) => Record<string, unknown>
) => GroupChatStorage;
export function createGroupCommandAccess(options: {
  store: TeamStore;
  binding: TeamBinding;
  storage?: GroupStorageFactory | undefined;
  state(): { members: TeamMember[] };
  authorize(principalId: string, permission: 'read' | 'message.write'): TeamGrant;
  receive(principalId: string, intent: CapturedGroupIntent): CommandReceipt;
  reserved(id: string): boolean;
  invalidate(): void;
}) {
  return (principalId: string, runtime: GroupRuntimeAccess) => {
    const authorize = (write: boolean) =>
      options.authorize(principalId, write ? 'message.write' : 'read');
    function original(row: Record<string, unknown>) {
      if (row.from !== 'user')
        throw new GroupChatError('invalid-user-request', 'Original is not a human request');
      if (row.groupMessageId !== undefined) {
        const receipts = listTeamCommandEntries(options.store).filter(
          (receipt): receipt is GroupCommandReceipt =>
            'family' in receipt &&
            receipt.family === 'group-chat' &&
            receipt.publication === 'requested' &&
            receipt.deliveries.length > 0 &&
            receipt.actor === 'user' &&
            receipt.request.operation === 'send' &&
            receipt.request.messageId === row.messageId &&
            receipt.request.groupChatId === row.groupChatId &&
            receipt.request.text === row.text &&
            receipt.request.summary === row.summary &&
            digest(receipt.request.taskRefs ?? []) === digest(row.taskRefs ?? [])
        );
        if (receipts.length !== 1)
          throw new GroupChatError(
            'invalid-user-request',
            'Group request has no original Team receipt'
          );
        const receipt = receipts[0]!,
          grant = options.authorize(receipt.principalId, 'message.write');
        if (grant.memberName !== 'user' || (grant.revision ?? 1) !== receipt.authorityRevision)
          throw new TeamOwnerError('forbidden');
        return row;
      }
      const matches = listProductCommandReceipts(options.store).filter(
        (receipt) =>
          receipt.phase === 'completed' &&
          receipt.command.operation === 'message.send' &&
          receipt.effects.messageId === row.messageId &&
          !!receipt.result &&
          typeof receipt.result === 'object' &&
          !Array.isArray(receipt.result) &&
          digest({ ...(receipt.result.message as Record<string, unknown>), read: false }) ===
            digest({ ...row, read: false })
      );
      if (matches.length !== 1)
        throw new GroupChatError(
          'invalid-user-request',
          'Request has no exact original Team receipt'
        );
      const receipt = matches[0]!,
        grant = options.authorize(receipt.principalId, 'message.write');
      if (grant.memberName !== 'user' || (grant.revision ?? 1) !== receipt.authorityRevision)
        throw new TeamOwnerError('forbidden');
      return { ...row, source: 'user_sent' };
    }
    return createGroupCommands({
      store: options.store,
      binding: options.binding,
      principalId,
      authorize,
      rosterFingerprint: () => digest(options.state().members),
      reserved: options.reserved,
      storage: (guard) => {
        if (!options.storage) throw new TeamOwnerError('hold');
        return options.storage(guard, original);
      },
      receive: (intent) => {
        const receipt = options.receive(principalId, intent);
        runtime.afterDelivery?.();
        return receipt;
      },
      ports: (guard) => ({
        roster: async () => {
          guard();
          return options.store.fenced(() => options.state().members.map((row) => row.name));
        },
        leadName: async () => {
          guard();
          return options.store.fenced(
            () => options.state().members.find((row) => row.role === 'lead')?.name ?? null
          );
        },
        getRun: async (_team, member) => {
          guard();
          const run = await runtime.getRun(member);
          guard();
          return run;
        },
        configurationOperation: async (_team, action) => {
          guard();
          const before = options.store.fenced(() => digest(options.state().members));
          if (!options.storage) throw new TeamOwnerError('hold');
          const result = await options
            .storage({ before: guard, inside: () => {} }, original)
            .logicalPost('configuration', action);
          guard();
          if (options.store.fenced(() => digest(options.state().members)) !== before)
            throw new TeamOwnerError('hold');
          return result;
        },
        deliver: async () => {
          throw new TeamOwnerError('hold');
        },
        changed: options.invalidate,
        reactionChanged: options.invalidate,
      }),
    });
  };
}
