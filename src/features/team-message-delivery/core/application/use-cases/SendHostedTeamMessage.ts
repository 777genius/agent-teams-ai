import { type QueryContext } from '@shared/contracts/hosted';

import { type SendHostedTeamMessageResult } from '../../../contracts/hosted';
import {
  normalizeHostedTeamMessageSendReceipt,
  parseSendHostedTeamMessageCommand,
} from '../../domain/hostedMessagePolicy';

import type { HostedTeamMessageSendPort } from '../ports/HostedTeamMessagePorts';

interface UnavailableResult {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
}

function unavailable(retryAfterMs?: number): UnavailableResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function validRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
    ? (value as number)
    : undefined;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasExactOptionalKey(
  value: Record<PropertyKey, unknown>,
  required: readonly string[],
  optional: string
): boolean {
  return hasExactKeys(value, Object.hasOwn(value, optional) ? [...required, optional] : required);
}

function normalizeSendResult(
  value: unknown,
  command: Parameters<HostedTeamMessageSendPort['send']>[0]
): SendHostedTeamMessageResult {
  if (!isRecord(value)) return unavailable();
  try {
    if (value.kind === 'persisted' || value.kind === 'idempotent_replay') {
      if (!hasExactKeys(value, ['kind', 'receipt'])) return unavailable();
      const receipt = normalizeHostedTeamMessageSendReceipt(value.receipt, command);
      if (!receipt.ok) return unavailable();
      return value.kind === 'persisted'
        ? Object.freeze({ kind: 'persisted', receipt: receipt.value })
        : Object.freeze({ kind: 'idempotent_replay', receipt: receipt.value });
    }
    if (value.kind === 'conflict') {
      return hasExactKeys(value, ['kind', 'reason']) && value.reason === 'idempotency_mismatch'
        ? Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' })
        : unavailable();
    }
    if (value.kind === 'not_found') {
      return hasExactKeys(value, ['kind']) ? Object.freeze({ kind: 'not_found' }) : unavailable();
    }
    // An unknown or removed teammate is a caller error, never an outage; only a named
    // recipient can be rejected.
    if (value.kind === 'invalid_recipient') {
      return hasExactKeys(value, ['kind']) && command.recipient !== undefined
        ? Object.freeze({ kind: 'invalid_request' })
        : unavailable();
    }
    if (value.kind === 'unavailable' && hasExactOptionalKey(value, ['kind'], 'retryAfterMs')) {
      return Object.hasOwn(value, 'retryAfterMs')
        ? unavailable(validRetryAfterMs(value.retryAfterMs))
        : unavailable();
    }
    return unavailable();
  } catch {
    return unavailable();
  }
}

/**
 * Sends through the one owner operation that stores and delivers the message. Durable
 * persistence and runtime delivery stay separate facts in the receipt, and a replay reports the
 * delivery state the owner recorded without sending again.
 */
export class SendHostedTeamMessage {
  constructor(private readonly sender: HostedTeamMessageSendPort) {}

  async execute(
    commandValue: unknown,
    context: QueryContext
  ): Promise<SendHostedTeamMessageResult> {
    const command = parseSendHostedTeamMessageCommand(commandValue);
    if (!command.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return unavailable();
    try {
      return normalizeSendResult(await this.sender.send(command.value, context), command.value);
    } catch {
      return unavailable();
    }
  }
}
