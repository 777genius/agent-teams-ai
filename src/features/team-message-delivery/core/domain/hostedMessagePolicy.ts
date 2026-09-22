import { parseCursor, parseRevision, parseTeamId, type TeamId } from '@shared/contracts/hosted';

import {
  HOSTED_MESSAGE_DIRECTIONS,
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  type HostedClientMessageId,
  type HostedMessagePageRequest,
  type HostedMessagePersistenceReceipt,
  type HostedMessageRuntimeDeliveryState,
  type HostedTeamMessage,
  parseHostedClientMessageId,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
  type SendHostedTeamMessageCommand,
} from '../../contracts/hosted';

export const HOSTED_MESSAGE_MAX_PAGE_ITEMS = 50;
export const HOSTED_MESSAGE_MAX_SOURCE_ITEMS = HOSTED_MESSAGE_MAX_PAGE_ITEMS + 1;
export const HOSTED_MESSAGE_MAX_TEXT_LENGTH = 4_000;

const PAGE_REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'teamId',
  'cursor',
  'expectedSourceGeneration',
  'limit',
] as const);
const MESSAGE_KEYS = Object.freeze([
  'teamId',
  'messageId',
  'direction',
  'text',
  'createdAtMs',
] as const);
const SEND_COMMAND_KEYS = Object.freeze([
  'schemaVersion',
  'teamId',
  'clientMessageId',
  'text',
] as const);
const PERSISTENCE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'teamId',
  'messageId',
  'clientMessageId',
  'persistence',
] as const);

export type HostedMessageParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

function success<T>(value: T): HostedMessageParseResult<T> {
  return Object.freeze({ ok: true, value });
}

function failure(): HostedMessageParseResult<never> {
  return Object.freeze({ ok: false });
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

function hasDisallowedControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 127 ||
      (code < 32 && code !== 9 && code !== 10) ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x061c ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Accept only canonical plain text. Rendering always uses text nodes, and requiring already-trimmed
 * LF text keeps the persisted value and an idempotent retry byte-for-byte identical.
 */
export function sanitizeHostedMessageText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > HOSTED_MESSAGE_MAX_TEXT_LENGTH ||
    value.trim() !== value ||
    value.includes('\r') ||
    hasDisallowedControl(value)
  ) {
    throw new TypeError('hosted-team-message-text-invalid');
  }
  return value;
}

export function parseHostedMessagePageRequest(
  value: unknown
): HostedMessageParseResult<HostedMessagePageRequest> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PAGE_REQUEST_KEYS)) return failure();
    const schemaVersion = value.schemaVersion;
    const cursor = value.cursor;
    const expectedSourceGeneration = value.expectedSourceGeneration;
    const limit = value.limit;
    if (
      schemaVersion !== HOSTED_TEAM_MESSAGE_SCHEMA_VERSION ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > HOSTED_MESSAGE_MAX_PAGE_ITEMS
    ) {
      return failure();
    }
    const parsedCursor = cursor === null ? null : parseCursor(cursor);
    const parsedSourceGeneration =
      expectedSourceGeneration === null
        ? null
        : parseHostedMessageSourceGeneration(expectedSourceGeneration);
    if ((parsedCursor === null) !== (parsedSourceGeneration === null)) return failure();
    return success(
      Object.freeze({
        schemaVersion,
        teamId: parseTeamId(value.teamId),
        cursor: parsedCursor,
        expectedSourceGeneration: parsedSourceGeneration,
        limit: limit as number,
      })
    );
  } catch {
    return failure();
  }
}

function parseHostedTeamMessage(value: unknown, expectedTeamId: TeamId): HostedTeamMessage {
  if (!isRecord(value) || !hasExactKeys(value, MESSAGE_KEYS)) {
    throw new TypeError('hosted-team-message-item-invalid');
  }
  const teamId = parseTeamId(value.teamId);
  if (
    teamId !== expectedTeamId ||
    !HOSTED_MESSAGE_DIRECTIONS.includes(
      value.direction as (typeof HOSTED_MESSAGE_DIRECTIONS)[number]
    ) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    (value.createdAtMs as number) < 0
  ) {
    throw new TypeError('hosted-team-message-item-invalid');
  }
  return Object.freeze({
    teamId,
    messageId: parseHostedMessageId(value.messageId),
    direction: value.direction as HostedTeamMessage['direction'],
    text: sanitizeHostedMessageText(value.text),
    createdAtMs: value.createdAtMs as number,
  });
}

/** Validates content without changing authority continuation order. */
export function normalizeHostedTeamMessages(
  value: unknown,
  expectedTeamId: TeamId
): HostedMessageParseResult<readonly HostedTeamMessage[]> {
  try {
    if (!Array.isArray(value) || value.length > HOSTED_MESSAGE_MAX_SOURCE_ITEMS) return failure();
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return failure();
    }
    const messages = value.map((message) => parseHostedTeamMessage(message, expectedTeamId));
    if (new Set(messages.map((message) => message.messageId)).size !== messages.length) {
      return failure();
    }
    return success(Object.freeze(messages));
  } catch {
    return failure();
  }
}

export function parseSendHostedTeamMessageCommand(
  value: unknown
): HostedMessageParseResult<SendHostedTeamMessageCommand> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, SEND_COMMAND_KEYS) ||
      value.schemaVersion !== HOSTED_TEAM_MESSAGE_SCHEMA_VERSION
    ) {
      return failure();
    }
    return success(
      Object.freeze({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId: parseTeamId(value.teamId),
        clientMessageId: parseHostedClientMessageId(value.clientMessageId),
        text: sanitizeHostedMessageText(value.text),
      })
    );
  } catch {
    return failure();
  }
}

export function normalizeHostedMessagePersistenceReceipt(
  value: unknown,
  command: SendHostedTeamMessageCommand
): HostedMessageParseResult<HostedMessagePersistenceReceipt> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PERSISTENCE_RECEIPT_KEYS)) return failure();
    if (
      value.schemaVersion !== HOSTED_TEAM_MESSAGE_SCHEMA_VERSION ||
      parseTeamId(value.teamId) !== command.teamId ||
      parseHostedClientMessageId(value.clientMessageId) !== command.clientMessageId ||
      value.persistence !== 'durable'
    ) {
      return failure();
    }
    return success(
      Object.freeze({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        teamId: command.teamId,
        messageId: parseHostedMessageId(value.messageId),
        clientMessageId: command.clientMessageId,
        persistence: 'durable',
      })
    );
  } catch {
    return failure();
  }
}

export function parseHostedMessageRuntimeDeliveryState(
  value: unknown
): HostedMessageRuntimeDeliveryState {
  if (value === 'delivered' || value === 'pending' || value === 'operator_required') {
    return value;
  }
  throw new TypeError('hosted-team-message-runtime-delivery-invalid');
}

export function parseHostedMessageRevision(value: unknown): ReturnType<typeof parseRevision> {
  return parseRevision(value);
}

export function parseHostedMessageClientId(value: unknown): HostedClientMessageId {
  return parseHostedClientMessageId(value);
}
