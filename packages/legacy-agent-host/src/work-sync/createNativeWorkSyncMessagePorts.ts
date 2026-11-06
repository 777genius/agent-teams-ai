import { createHash } from 'node:crypto';
import { TeamOwnerError } from '../team/contracts.js';
import type { NativeWorkSyncMemberContext } from '../composition/nativeWorkSyncContext.js';
import type { NativeMcpAuthorityProof } from '../team/NativeMcpAuthority.js';
import type { MemberWorkSyncUseCaseDeps } from './policy/core/application/ports.js';

const messageCommand = (messageId: string) =>
  `work-sync-delivery:${createHash('sha256').update(messageId).digest('hex')}`;

/** Same Team message use case, authenticated native sender, exact self-recipient and original accepted intent. */
export function createNativeWorkSyncMessagePorts(options: {
  member: NativeWorkSyncMemberContext;
  team: Readonly<NativeMcpAuthorityProof>;
  assertCurrent(): void;
}): Pick<
  MemberWorkSyncUseCaseDeps,
  'busySignal' | 'inboxNudge' | 'reviewPickupDelivery' | 'nudgeDeliveryWake'
> {
  const { member, team, assertCurrent } = options;
  const delivery = member.delivery;
  if (!delivery) throw new TeamOwnerError('hold');
  const connection = member.owner.connect(team.principalId);
  const assertScope = (teamName: string, memberName: string) => {
    assertCurrent();
    if (teamName !== member.teamName || memberName !== team.memberName)
      throw new TeamOwnerError('forbidden');
  };
  const busy = () => {
    assertCurrent();
    const current = delivery.readRuntime().record;
    return (
      !current ||
      current.inputs.some((row) => ['claimed', 'consumed', 'unknown'].includes(row.phase))
    );
  };
  return {
    busySignal: {
      async isBusy(scope) {
        assertScope(scope.teamName, scope.memberName);
        return { busy: busy(), reason: 'original_runtime_input_active' };
      },
    },
    inboxNudge: {
      async insertIfAbsent(request) {
        assertScope(request.teamName, request.memberName);
        if (await request.shouldAbort?.())
          return { inserted: false, messageId: request.messageId, aborted: true };
        assertCurrent();
        if (busy()) return { inserted: false, messageId: request.messageId, aborted: true };
        const commandId = messageCommand(request.messageId);
        const prior = connection.lookup(commandId);
        const command = {
          commandId,
          operation: 'message.send' as const,
          payload: {
            to: team.memberName,
            text: request.payload.text,
            messageId: commandId,
            actionMode: 'do' as const,
            ...(request.payload.taskRefs?.length ? { taskRefs: request.payload.taskRefs } : {}),
          },
        };
        // TeamOwner remains the sole message/inbox/outbox writer and captures the actual native sender.
        const receipt = connection.execute(command);
        const result = receipt.result;
        assertCurrent();
        if (
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          result.messageId !== commandId
        )
          throw new TeamOwnerError('hold');
        return { inserted: !prior, messageId: commandId };
      },
    },
    reviewPickupDelivery: {
      canDeliver(scope) {
        assertScope(scope.teamName, scope.memberName);
        return { ok: true };
      },
      async deliver(request) {
        assertScope(request.teamName, request.memberName);
        await delivery.settleDeliveries();
        assertCurrent();
        const receipt = connection.lookup(request.messageId);
        const inputId = receipt?.effects.deliveryId;
        const matches =
          delivery
            .readRuntime()
            .record?.inputs.filter(
              (row) => row.intent.inputId === inputId && row.intent.messageId === request.messageId
            ) ?? [];
        if (matches.length === 1 && ['consumed', 'terminal'].includes(matches[0]!.phase))
          return { ok: true, state: 'prompt_accepted', messageId: request.messageId };
        return {
          ok: false,
          reason: 'retryable_failure',
          message: 'original_runtime_delivery_not_accepted',
        };
      },
    },
    nudgeDeliveryWake: {
      async schedule(scope) {
        assertScope(scope.teamName, scope.memberName);
        await delivery.settleDeliveries();
        assertCurrent();
      },
    },
  };
}
