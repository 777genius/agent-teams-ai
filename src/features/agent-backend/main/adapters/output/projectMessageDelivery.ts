import { row } from './projectRuntimeActivity';

import type { BackendCommandReceipt, BackendOperationRequest } from '../../../contracts/operations';

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\0\r\n]/u.test(value))
    throw new Error('Invalid message delivery identity');
  return value;
}

/** A read-only locator from the original canonical receipt, never a new delivery or native proof. */
export function projectMessageDelivery(
  source: Record<string, unknown>,
  request: BackendOperationRequest
): BackendCommandReceipt['messageDelivery'] {
  if (
    request.operation !== 'command.lookup' ||
    source.phase !== 'completed' ||
    row(source.command).operation !== 'message.send' ||
    source.deliveryBinding === undefined
  )
    return undefined;
  const command = row(source.command);
  if (
    source.schemaVersion !== 1 ||
    source.commandId !== request.commandId ||
    command.commandId !== request.commandId
  )
    throw new Error('Wrong original message command');
  const binding = row(source.binding),
    delivery = row(source.deliveryBinding);
  for (const key of ['backendId', 'teamId', 'teamName'] as const)
    if (identity(binding[key]) !== identity(delivery[key]))
      throw new Error('Wrong original message delivery binding');
  identity(delivery.runId);
  const memberId = identity(delivery.memberId),
    generation = identity(delivery.generation);
  const applied = row(source.result),
    effects = row(source.effects),
    payload = row(command.payload);
  const messageId = identity(applied.messageId);
  if (
    identity(effects.messageId) !== messageId ||
    (payload.messageId !== undefined && identity(payload.messageId) !== messageId)
  )
    throw new Error('Wrong original message effect');
  // Host-local /cost has a captured recipient but no native delivery. Its
  // prepared effects.deliveryId must never be adopted as an actual input.
  if (applied.deliveryId === undefined) return undefined;
  const inputId = identity(applied.deliveryId);
  if (identity(effects.deliveryId) !== inputId) throw new Error('Wrong original delivery effect');
  // commitTeamMessage writes the canonical DeliveryIntent inputId = deliveryId.
  return { memberId, generation, inputId };
}
