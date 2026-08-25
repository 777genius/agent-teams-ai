import {
  EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION,
  type EventJournalWatermark,
  REPLAY_CURSOR_SCHEMA_VERSION,
  type ReplayCursor,
  type ReplayCursorPosition,
} from '../../contracts';

const REPLAY_CURSOR_PREFIX = 'cev';
const MAX_CURSOR_LENGTH = 2_048;
const MAX_CURSOR_IDENTITY_LENGTH = 256;
const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type ReplayCursorErrorCode =
  | 'invalid_replay_cursor'
  | 'unsupported_replay_cursor_version'
  | 'invalid_journal_watermark'
  | 'replay_cursor_deployment_mismatch'
  | 'replay_cursor_epoch_mismatch'
  | 'replay_cursor_stale'
  | 'replay_cursor_ahead';

export class ReplayCursorError extends Error {
  constructor(
    readonly code: ReplayCursorErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'ReplayCursorError';
  }
}

export function encodeReplayCursor(
  input: Omit<ReplayCursorPosition, 'cursorVersion'> & {
    readonly cursorVersion?: typeof REPLAY_CURSOR_SCHEMA_VERSION;
  }
): ReplayCursor {
  const position = {
    cursorVersion: input.cursorVersion ?? REPLAY_CURSOR_SCHEMA_VERSION,
    deploymentId: input.deploymentId,
    eventEpoch: input.eventEpoch,
    eventSequence: input.eventSequence,
  } satisfies ReplayCursorPosition;
  assertReplayCursorPosition(position);

  const payload = JSON.stringify([
    position.cursorVersion,
    position.deploymentId,
    position.eventEpoch,
    position.eventSequence,
  ]);
  const cursor = `${REPLAY_CURSOR_PREFIX}${position.cursorVersion}.${encodeBase64Url(payload)}`;
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor('Replay cursor exceeds its encoded size bound');
  }
  return cursor as ReplayCursor;
}

export const createReplayCursor = encodeReplayCursor;

export function decodeReplayCursor(cursor: string): ReplayCursorPosition {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    cursor.trim() !== cursor
  ) {
    throw invalidCursor('Replay cursor must be a bounded non-empty canonical string');
  }

  const match = /^cev(\d+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match) {
    throw invalidCursor('Replay cursor has an invalid envelope');
  }

  const envelopeVersion = Number(match[1]);
  if (!Number.isSafeInteger(envelopeVersion) || envelopeVersion !== REPLAY_CURSOR_SCHEMA_VERSION) {
    throw new ReplayCursorError(
      'unsupported_replay_cursor_version',
      'Replay cursor version is not supported',
      { cursorVersion: match[1] }
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(match[2])) as unknown;
  } catch (error) {
    throw invalidCursor('Replay cursor payload is malformed', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!Array.isArray(decoded) || decoded.length !== 4) {
    throw invalidCursor('Replay cursor payload must use the canonical tuple shape');
  }

  const [cursorVersion, deploymentId, eventEpoch, eventSequence] = decoded;
  if (
    typeof cursorVersion !== 'number' ||
    typeof deploymentId !== 'string' ||
    typeof eventEpoch !== 'string' ||
    typeof eventSequence !== 'number'
  ) {
    throw invalidCursor('Replay cursor payload fields have invalid types');
  }
  if (cursorVersion !== envelopeVersion) {
    throw invalidCursor('Replay cursor envelope and payload versions disagree');
  }

  const position = {
    cursorVersion,
    deploymentId,
    eventEpoch,
    eventSequence,
  } as ReplayCursorPosition;
  assertReplayCursorPosition(position);

  if (encodeReplayCursor(position) !== cursor) {
    throw invalidCursor('Replay cursor is not canonically encoded');
  }

  return Object.freeze(position);
}

export function validateReplayCursor(
  cursor: string,
  watermark: EventJournalWatermark
): ReplayCursorPosition {
  const immutableWatermark = materializeEventJournalWatermark(watermark);
  const position = decodeReplayCursor(cursor);

  if (position.deploymentId !== immutableWatermark.deploymentId) {
    throw new ReplayCursorError(
      'replay_cursor_deployment_mismatch',
      'Replay cursor belongs to another deployment',
      {
        cursorDeploymentId: position.deploymentId,
        expectedDeploymentId: immutableWatermark.deploymentId,
      }
    );
  }
  if (position.eventEpoch !== immutableWatermark.eventEpoch) {
    throw new ReplayCursorError(
      'replay_cursor_epoch_mismatch',
      'Replay cursor belongs to another event epoch',
      {
        cursorEventEpoch: position.eventEpoch,
        expectedEventEpoch: immutableWatermark.eventEpoch,
      }
    );
  }
  if (position.eventSequence < immutableWatermark.retentionFloorSequence) {
    throw new ReplayCursorError(
      'replay_cursor_stale',
      'Replay cursor is below the retained journal floor',
      {
        cursorSequence: position.eventSequence,
        retentionFloorSequence: immutableWatermark.retentionFloorSequence,
      }
    );
  }
  if (position.eventSequence > immutableWatermark.highWatermarkSequence) {
    throw new ReplayCursorError(
      'replay_cursor_ahead',
      'Replay cursor is ahead of the durable journal',
      {
        cursorSequence: position.eventSequence,
        highWatermarkSequence: immutableWatermark.highWatermarkSequence,
      }
    );
  }

  return position;
}

/**
 * Copies a journal-owned watermark without invoking accessors, then validates
 * and freezes the copy. Journal adapters are a trust boundary: their mutable
 * return objects must never become application state by reference.
 */
export function materializeEventJournalWatermark(value: unknown): EventJournalWatermark {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidWatermark('Event journal watermark must be a data object');
  }
  const record = value;
  const watermark = Object.freeze({
    schemaVersion: readWatermarkDataProperty(record, 'schemaVersion'),
    deploymentId: readWatermarkDataProperty(record, 'deploymentId'),
    eventEpoch: readWatermarkDataProperty(record, 'eventEpoch'),
    retentionFloorSequence: readWatermarkDataProperty(record, 'retentionFloorSequence'),
    highWatermarkSequence: readWatermarkDataProperty(record, 'highWatermarkSequence'),
  }) as EventJournalWatermark;
  assertJournalWatermark(watermark);
  return watermark;
}

export function isReplayCursor(value: unknown): value is ReplayCursor {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    decodeReplayCursor(value);
    return true;
  } catch {
    return false;
  }
}

export function assertJournalWatermark(
  watermark: EventJournalWatermark
): asserts watermark is EventJournalWatermark {
  if (!watermark || watermark.schemaVersion !== EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION) {
    throw new ReplayCursorError(
      'invalid_journal_watermark',
      'Event journal watermark version is not supported',
      { schemaVersion: watermark?.schemaVersion }
    );
  }
  assertIdentity(watermark.deploymentId, 'deploymentId', 'invalid_journal_watermark');
  assertIdentity(watermark.eventEpoch, 'eventEpoch', 'invalid_journal_watermark');
  if (
    !isSequence(watermark.retentionFloorSequence) ||
    !isSequence(watermark.highWatermarkSequence) ||
    watermark.retentionFloorSequence > watermark.highWatermarkSequence
  ) {
    throw new ReplayCursorError(
      'invalid_journal_watermark',
      'Event journal watermark sequence range is invalid',
      {
        retentionFloorSequence: watermark.retentionFloorSequence,
        highWatermarkSequence: watermark.highWatermarkSequence,
      }
    );
  }
}

function assertReplayCursorPosition(position: ReplayCursorPosition): void {
  if (position.cursorVersion !== REPLAY_CURSOR_SCHEMA_VERSION) {
    throw new ReplayCursorError(
      'unsupported_replay_cursor_version',
      'Replay cursor version is not supported',
      { cursorVersion: position.cursorVersion }
    );
  }
  assertIdentity(position.deploymentId, 'deploymentId', 'invalid_replay_cursor');
  assertIdentity(position.eventEpoch, 'eventEpoch', 'invalid_replay_cursor');
  if (!isSequence(position.eventSequence)) {
    throw invalidCursor('Replay cursor eventSequence must be a non-negative safe integer', {
      eventSequence: position.eventSequence,
    });
  }
}

function assertIdentity(
  value: string,
  field: string,
  code: 'invalid_replay_cursor' | 'invalid_journal_watermark'
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CURSOR_IDENTITY_LENGTH ||
    value.trim() !== value
  ) {
    throw new ReplayCursorError(code, `Replay cursor ${field} is invalid`, { field });
  }
}

function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalidCursor(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): ReplayCursorError {
  return new ReplayCursorError('invalid_replay_cursor', message, details);
}

function invalidWatermark(message: string): ReplayCursorError {
  return new ReplayCursorError('invalid_journal_watermark', message);
}

function readWatermarkDataProperty(record: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw invalidWatermark(`Event journal watermark ${field} must be an enumerable data property`);
  }
  return descriptor.value;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_URL_ALPHABET[(combined >>> 18) & 63];
    encoded += BASE64_URL_ALPHABET[(combined >>> 12) & 63];
    if (second !== undefined) {
      encoded += BASE64_URL_ALPHABET[(combined >>> 6) & 63];
    }
    if (third !== undefined) {
      encoded += BASE64_URL_ALPHABET[combined & 63];
    }
  }
  return encoded;
}

function decodeBase64Url(value: string): string {
  if (value.length === 0 || value.length % 4 === 1) {
    throw new Error('Invalid base64url length');
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;
  for (const character of value) {
    const digit = BASE64_URL_ALPHABET.indexOf(character);
    if (digit < 0) {
      throw new Error('Invalid base64url character');
    }
    buffer = (buffer << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >>> bitCount) & 255);
      buffer &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0 && buffer !== 0) {
    throw new Error('Invalid base64url trailing bits');
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}
