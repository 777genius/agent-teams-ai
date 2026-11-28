import { HostTeamOperationError } from './createHostTeamMutations';
import { captureHostProjectFamily } from './hostProjectBindings';

import type { AgentBackendApi, BackendCommandReceipt } from '../contracts/operations';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type { HostMessageDeliveryStatus } from '@shared/types/teamMessageDelivery';

/** Read the original command and exact Runtime input without admitting or resending anything. */
export function createHostMessageDeliveryStatus(
  backend: AgentBackendApi,
  captureScope: () => () => boolean,
  readOrder: TeamProductReadOrder
) {
  return async (teamName: string, messageId: string): Promise<HostMessageDeliveryStatus> => {
    if (
      typeof messageId !== 'string' ||
      !messageId ||
      messageId.length > 256 ||
      messageId !== messageId.trim() ||
      Array.from(messageId).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw new HostTeamOperationError('invalid', 'not-dispatched');
    const currentScope = captureScope();
    const current = () => {
      if (!currentScope()) throw new HostTeamOperationError('context-changed', 'not-dispatched');
    };
    current();
    const family = captureHostProjectFamily(await backend.getConnections(), teamName);
    current();
    const handle = { ...family.selected.handle };
    readOrder.capture(currentScope);
    const fence = readOrder.readFence(handle.handleId);
    const assertCurrent = () => {
      current();
      fence();
    };
    const lookup = async (): Promise<BackendCommandReceipt | null> => {
      const result = await backend.invoke({
        handle,
        commandId: messageId,
        operation: 'command.lookup',
        payload: {},
      });
      assertCurrent();
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      if (result.value === null) return null;
      const receipt = result.value;
      if (
        !receipt ||
        !('operation' in receipt) ||
        'kind' in receipt ||
        receipt.operation !== 'message.send' ||
        receipt.commandId !== messageId ||
        (receipt.messageId !== undefined && receipt.messageId !== messageId)
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      return structuredClone(receipt);
    };
    const receipt = await lookup();
    const identity = JSON.stringify(receipt);
    let observation: Pick<HostMessageDeliveryStatus, 'confirmation' | 'responsePending' | 'phase'>;
    if (!receipt) {
      observation = { confirmation: 'unconfirmed', responsePending: false, phase: 'not-recorded' };
    } else if (receipt.phase !== 'completed') {
      observation = {
        confirmation: ['prepared', 'applying'].includes(receipt.phase) ? 'pending' : 'unconfirmed',
        responsePending: receipt.phase !== 'rejected',
        phase: receipt.phase,
      };
    } else if (!receipt.messageDelivery) {
      observation = { confirmation: 'unconfirmed', responsePending: false, phase: 'unavailable' };
    } else {
      const selected = receipt.messageDelivery;
      if (!selected.memberId || !selected.generation || selected.inputId !== receipt.deliveryId)
        throw new HostTeamOperationError('invalid-result', 'unknown');
      const result = await backend.invoke({
        handle,
        commandId: crypto.randomUUID(),
        operation: 'runtime.read',
        payload: { memberId: selected.memberId, expectedGeneration: selected.generation },
      });
      assertCurrent();
      if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
      const runtime = result.value;
      if (
        !runtime ||
        !('attached' in runtime) ||
        runtime.memberId !== selected.memberId ||
        runtime.generation !== selected.generation ||
        !Array.isArray(runtime.inputs)
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      const inputs = runtime.inputs.filter((input) => input.inputId === selected.inputId);
      if (inputs.length > 1) throw new HostTeamOperationError('invalid-result', 'unknown');
      const input = inputs[0];
      if (!input || ['admitted', 'claimed'].includes(input.phase)) {
        observation = {
          confirmation: 'pending',
          responsePending: true,
          phase: input?.phase ?? 'pending-admission',
        };
      } else if (['consumed', 'terminal'].includes(input.phase)) {
        observation = { confirmation: 'confirmed', responsePending: false, phase: input.phase };
      } else if (['unknown', 'not-sent', 'cancelled', 'rejected'].includes(input.phase)) {
        observation = {
          confirmation: 'unconfirmed',
          responsePending: input.phase === 'unknown',
          phase: input.phase,
        };
      } else throw new HostTeamOperationError('invalid-result', 'unknown');
    }
    if (JSON.stringify(await lookup()) !== identity)
      throw new HostTeamOperationError('conflict', 'not-dispatched');
    family.assertSame(await backend.getConnections());
    assertCurrent();
    return { source: 'captured-host', messageId, ...observation };
  };
}
