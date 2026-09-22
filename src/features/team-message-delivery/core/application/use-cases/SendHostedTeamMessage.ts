import { type QueryContext } from '@shared/contracts/hosted';

import {
  type HostedMessagePersistenceReceipt,
  type HostedMessageRuntimeDeliveryState,
  type SendHostedTeamMessageResult,
} from '../../../contracts/hosted';
import {
  normalizeHostedMessagePersistenceReceipt,
  parseHostedMessageRuntimeDeliveryState,
  parseSendHostedTeamMessageCommand,
} from '../../domain/hostedMessagePolicy';

import type {
  HostedMessageRuntimeDeliveryResult,
  HostedTeamMessagePersistencePort,
  HostedTeamMessageRuntimeDeliveryPort,
} from '../ports/HostedTeamMessagePorts';

interface UnavailableAdmission {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
}

function unavailable(retryAfterMs?: number): UnavailableAdmission {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function validRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
    ? (value as number)
    : undefined;
}

type PersistenceAdmission =
  | { readonly kind: 'persisted'; readonly receipt: HostedMessagePersistenceReceipt }
  | { readonly kind: 'idempotent_replay'; readonly receipt: HostedMessagePersistenceReceipt }
  | { readonly kind: 'conflict'; readonly reason: 'idempotency_mismatch' }
  | { readonly kind: 'not_found' }
  | UnavailableAdmission;

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

function normalizePersistenceAdmission(
  value: unknown,
  command: Parameters<HostedTeamMessagePersistencePort['persist']>[0]
): PersistenceAdmission {
  if (!isRecord(value)) return unavailable();
  try {
    if (value.kind === 'persisted' || value.kind === 'idempotent_replay') {
      if (!hasExactKeys(value, ['kind', 'receipt'])) return unavailable();
      const receipt = normalizeHostedMessagePersistenceReceipt(value.receipt, command);
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

function runtimeDeliveryState(value: unknown): HostedMessageRuntimeDeliveryState {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'operator_required';
    const result = value as HostedMessageRuntimeDeliveryResult;
    const keys = Reflect.ownKeys(result);
    if (
      result.kind === 'delivered' ||
      result.kind === 'pending' ||
      result.kind === 'operator_required'
    ) {
      if (keys.length !== 1 || keys[0] !== 'kind') return 'operator_required';
      return parseHostedMessageRuntimeDeliveryState(result.kind);
    }
    if (
      result.kind === 'unavailable' &&
      ((keys.length === 1 && keys[0] === 'kind') ||
        (keys.length === 2 &&
          keys.includes('kind') &&
          keys.includes('retryAfterMs') &&
          Number.isSafeInteger(result.retryAfterMs)))
    ) {
      return 'pending';
    }
    return 'operator_required';
  } catch {
    return 'operator_required';
  }
}

/** Persists before runtime delivery and returns stable ambiguity without exposing runtime details. */
export class SendHostedTeamMessage {
  constructor(
    private readonly persistence: HostedTeamMessagePersistencePort,
    private readonly runtimeDelivery: HostedTeamMessageRuntimeDeliveryPort
  ) {}

  async execute(
    commandValue: unknown,
    context: QueryContext
  ): Promise<SendHostedTeamMessageResult> {
    const command = parseSendHostedTeamMessageCommand(commandValue);
    if (!command.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return unavailable();

    try {
      const admitted = normalizePersistenceAdmission(
        await this.persistence.persist(command.value, context),
        command.value
      );
      if (context.signal.aborted) return unavailable();
      if (
        admitted.kind === 'conflict' ||
        admitted.kind === 'not_found' ||
        admitted.kind === 'unavailable'
      ) {
        return admitted;
      }

      let delivery: HostedMessageRuntimeDeliveryState =
        admitted.kind === 'idempotent_replay' ? 'operator_required' : 'pending';
      if (admitted.kind === 'persisted' && !context.signal.aborted) {
        try {
          delivery = runtimeDeliveryState(
            await this.runtimeDelivery.deliver(
              Object.freeze({
                teamId: command.value.teamId,
                messageId: admitted.receipt.messageId,
                clientMessageId: command.value.clientMessageId,
                text: command.value.text,
              }),
              context
            )
          );
        } catch {
          delivery = 'operator_required';
        }
      }

      const publicReceipt = Object.freeze({ ...admitted.receipt, runtimeDelivery: delivery });
      return admitted.kind === 'persisted'
        ? Object.freeze({ kind: 'persisted', receipt: publicReceipt })
        : Object.freeze({ kind: 'idempotent_replay', receipt: publicReceipt });
    } catch {
      return unavailable();
    }
  }
}
