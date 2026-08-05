import {
  createSafeAppError,
  type Cursor,
  HOSTED_SCHEMA_VERSION,
  type MemberId,
  parseCursor,
  parseMemberId,
  parseRevision,
  parseTeamId,
  type Revision,
  type SafeAppError,
  type TeamId,
} from '@shared/contracts/hosted';

declare const hostedMemberLogBrand: unique symbol;

type HostedMemberLogOpaqueValue<Name extends string> = string & {
  readonly [hostedMemberLogBrand]: Name;
};

/** An authority-issued opaque identity for one browser-safe member-log entry. */
export type HostedMemberLogEntryId = HostedMemberLogOpaqueValue<'HostedMemberLogEntryId'>;
/** An authenticated, authority-issued locator for one selected member log. */
export type HostedMemberLogSelectionId = HostedMemberLogOpaqueValue<'HostedMemberLogSelectionId'>;
/** Binds a continuation to one immutable member-log source snapshot. */
export type HostedMemberLogSourceGeneration =
  HostedMemberLogOpaqueValue<'HostedMemberLogSourceGeneration'>;

export const HOSTED_MEMBER_LOG_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;
export const HOSTED_MEMBER_LOG_PAGE_HTTP_PATH = '/api/hosted/v1/member-log/page' as const;

export const HOSTED_MEMBER_LOG_MAX_PAGE_ITEMS = 50;
export const HOSTED_MEMBER_LOG_MAX_SOURCE_ITEMS = HOSTED_MEMBER_LOG_MAX_PAGE_ITEMS + 1;
export const HOSTED_MEMBER_LOG_MAX_PAGE_BYTES = 64 * 1024;
export const HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS = 250;
export const HOSTED_MEMBER_LOG_MAX_TEXT_LENGTH = 4_000;
/** Prevents one visible member-log view from retaining an unbounded continuation history. */
export const HOSTED_MEMBER_LOG_MAX_RENDERED_ENTRIES = 200;
/** Caps browser cursor tracking; reaching it stops pagination rather than forgetting loop evidence. */
export const HOSTED_MEMBER_LOG_MAX_CURSOR_HISTORY = 200;

const ENTRY_ID = /^member_log_[0-9a-f]{32}$/;
const SELECTION_ID = /^member_log_selection_[0-9a-f]{32}$/;
const SOURCE_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/;

const PAGE_REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'selectionId',
  'cursor',
  'expectedSourceGeneration',
  'limit',
] as const);
const ENTRY_KEYS = Object.freeze([
  'teamId',
  'memberId',
  'entryId',
  'level',
  'occurredAtMs',
  'text',
]);
const PAGE_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'selectionId',
  'teamId',
  'memberId',
  'sourceGeneration',
  'revision',
  'entries',
  'nextCursor',
  'truncated',
  'truncationReasons',
  'budget',
] as const);
const BUDGET_KEYS = Object.freeze([
  'itemLimit',
  'byteLimit',
  'timeLimitMs',
  'usedItems',
  'usedBytes',
  'elapsedMs',
] as const);
const ERROR_REQUIRED_KEYS = Object.freeze(['schemaVersion', 'kind', 'error', 'retryable'] as const);
const ERROR_ALLOWED_KEYS = Object.freeze([
  ...ERROR_REQUIRED_KEYS,
  'currentSourceGeneration',
] as const);

const REDACTED = '[REDACTED]';
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** Cookie attributes can themselves carry credentials, so their values are all-or-nothing. */
const COOKIE_HEADER_VALUE = /(\b(?:set-)?cookie\b\s*[:=]\s*)[^\r\n]*/gi;
const AUTHORIZATION_VALUE = /(\b(?:proxy-)?authorization)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi;
const NAMED_SECRET_VALUE =
  /\b((?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|key|token|password|(?:aws[_-]?)?secret(?:[_-]?(?:access[_-]?)?key)?))(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
/** Connection strings are sensitive even when their exact URL format is not recognized. */
const CONNECTION_VALUE =
  /\b((?:(?:[A-Za-z0-9]+[_-])?(?:(?:database|db|postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|amqp|kafka)[_-]?(?:url|uri|dsn)|connection(?:[_-]?string)?|dsn))["']?)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
/** Covers provider-specific labels before a new credential naming scheme can be allowlisted. */
const UNKNOWN_CREDENTIAL_VALUE =
  /\b([A-Za-z][A-Za-z0-9_-]*(?:auth(?:entication|orization)?|credential|secret|token|password|passwd|passphrase|cookie|session|key)[A-Za-z0-9_-]*["']?)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const BEARER_VALUE = /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const TOKEN_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g;
/** A URI with user info or sensitive query params is never browser-safe. */
const CREDENTIAL_BEARING_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@"`<>|]*@[^\s"'`<>|]*/gi;
const CREDENTIAL_QUERY_URL =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>|]*[?&][^\s"'`<>|=]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|secret|token|password|passwd|passphrase|key)[^\s"'`<>|=]*=[^\s"'`<>|]*/gi;
/** Long, high-entropy opaque values are treated as credentials unless the contract explicitly models them. */
const OPAQUE_CREDENTIAL_VALUE = /\b[A-Za-z0-9._~+/-]{24,}\b/g;
const USER_PATH = /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+(?:\/[^\s"'`<>|]*)*/g;
const WINDOWS_USER_PATH = /[A-Za-z]:\\Users\\[^\s"'`<>|]*/g;
const EMAIL_ADDRESS =
  /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/g;

const textEncoder = new TextEncoder();

export const HOSTED_MEMBER_LOG_LEVELS = Object.freeze(['info', 'warning', 'error'] as const);
export type HostedMemberLogLevel = (typeof HOSTED_MEMBER_LOG_LEVELS)[number];

export const HOSTED_MEMBER_LOG_TRUNCATION_REASONS = Object.freeze([
  'item_budget',
  'byte_budget',
  'time_budget',
  'source_budget',
] as const);
export type HostedMemberLogTruncationReason = (typeof HOSTED_MEMBER_LOG_TRUNCATION_REASONS)[number];

export interface HostedMemberLogEntry {
  readonly teamId: TeamId;
  readonly memberId: MemberId;
  readonly entryId: HostedMemberLogEntryId;
  readonly level: HostedMemberLogLevel;
  readonly occurredAtMs: number;
  /** Redacted plain text only; source metadata and raw sensitive text are never browser data. */
  readonly text: string;
}

export interface HostedMemberLogPageRequest {
  readonly schemaVersion: typeof HOSTED_MEMBER_LOG_SCHEMA_VERSION;
  /** Opaque locator only. The server resolves workspace and member authority from its live grant. */
  readonly selectionId: HostedMemberLogSelectionId;
  readonly cursor: Cursor | null;
  readonly expectedSourceGeneration: HostedMemberLogSourceGeneration | null;
  readonly limit: number;
}

export interface HostedMemberLogPageBudget {
  readonly itemLimit: number;
  readonly byteLimit: number;
  readonly timeLimitMs: number;
  readonly usedItems: number;
  /** Exact UTF-8 byte count of the complete JSON page envelope, entries and metadata included. */
  readonly usedBytes: number;
  readonly elapsedMs: number;
}

export interface HostedMemberLogPage {
  readonly schemaVersion: typeof HOSTED_MEMBER_LOG_SCHEMA_VERSION;
  readonly kind: 'member_log_page';
  readonly selectionId: HostedMemberLogSelectionId;
  /** Opaque authority projection; never selected from caller-provided workspace/member input. */
  readonly teamId: TeamId;
  readonly memberId: MemberId;
  readonly sourceGeneration: HostedMemberLogSourceGeneration;
  readonly revision: Revision;
  /** Authority continuation order is preserved exactly. */
  readonly entries: readonly HostedMemberLogEntry[];
  readonly nextCursor: Cursor | null;
  readonly truncated: boolean;
  readonly truncationReasons: readonly HostedMemberLogTruncationReason[];
  readonly budget: HostedMemberLogPageBudget;
}

export type GetHostedMemberLogPageResult =
  | { readonly kind: 'success'; readonly page: HostedMemberLogPage }
  | { readonly kind: 'invalid_request' }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedMemberLogSourceGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedMemberLogErrorEnvelope {
  readonly schemaVersion: typeof HOSTED_MEMBER_LOG_SCHEMA_VERSION;
  readonly kind: 'error';
  readonly error: SafeAppError;
  readonly retryable: boolean;
  readonly currentSourceGeneration?: HostedMemberLogSourceGeneration;
}

export type HostedMemberLogParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

function success<T>(value: T): HostedMemberLogParseResult<T> {
  return Object.freeze({ ok: true, value });
}

function failure(): HostedMemberLogParseResult<never> {
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

function safeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function parsePlainHostedMemberLogText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > HOSTED_MEMBER_LOG_MAX_TEXT_LENGTH ||
    value.trim().length === 0 ||
    value.includes('\r') ||
    hasDisallowedControl(value)
  ) {
    throw new TypeError('hosted-member-log-text-invalid');
  }
  return value;
}

function redactOpaqueCredentialValue(value: string): string {
  const distinctCharacters = new Set(value).size;
  const characterClasses = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[._~+/-]/.test(value),
  ].filter(Boolean).length;
  return characterClasses >= 2 || distinctCharacters >= 12 ? REDACTED : value;
}

export function parseHostedMemberLogEntryId(value: unknown): HostedMemberLogEntryId {
  if (typeof value !== 'string' || !ENTRY_ID.test(value)) {
    throw new TypeError('hosted-member-log-entry-id-invalid');
  }
  return value as HostedMemberLogEntryId;
}

export function parseHostedMemberLogSelectionId(value: unknown): HostedMemberLogSelectionId {
  if (typeof value !== 'string' || !SELECTION_ID.test(value)) {
    throw new TypeError('hosted-member-log-selection-id-invalid');
  }
  return value as HostedMemberLogSelectionId;
}

export function parseHostedMemberLogSourceGeneration(
  value: unknown
): HostedMemberLogSourceGeneration {
  if (typeof value !== 'string' || !SOURCE_GENERATION.test(value)) {
    throw new TypeError('hosted-member-log-source-generation-invalid');
  }
  return value as HostedMemberLogSourceGeneration;
}

/** Removes credential, private-key, personal-path, and email material before any browser boundary. */
export function redactHostedMemberLogText(value: unknown): string {
  const text = parsePlainHostedMemberLogText(value);
  return text
    .replace(PRIVATE_KEY, REDACTED)
    .replace(COOKIE_HEADER_VALUE, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(
      AUTHORIZATION_VALUE,
      (_match, label: string, separator: string) => `${label}${separator}${REDACTED}`
    )
    .replace(
      NAMED_SECRET_VALUE,
      (_match, label: string, separator: string) => `${label}${separator}${REDACTED}`
    )
    .replace(
      CONNECTION_VALUE,
      (_match, label: string, separator: string) => `${label}${separator}${REDACTED}`
    )
    .replace(
      UNKNOWN_CREDENTIAL_VALUE,
      (_match, label: string, separator: string) => `${label}${separator}${REDACTED}`
    )
    .replace(BEARER_VALUE, `Bearer ${REDACTED}`)
    .replace(TOKEN_VALUE, REDACTED)
    .replace(CREDENTIAL_BEARING_URL, REDACTED)
    .replace(CREDENTIAL_QUERY_URL, REDACTED)
    .replace(USER_PATH, '[REDACTED_PATH]')
    .replace(WINDOWS_USER_PATH, '[REDACTED_PATH]')
    .replace(EMAIL_ADDRESS, '[REDACTED_EMAIL]')
    .replace(OPAQUE_CREDENTIAL_VALUE, redactOpaqueCredentialValue);
}

/** Accepts only redacted, bounded, renderer-safe text. Rendering must still use text nodes. */
export function parseHostedMemberLogText(value: unknown): string {
  const text = parsePlainHostedMemberLogText(value);
  if (redactHostedMemberLogText(text) !== text) {
    throw new TypeError('hosted-member-log-text-unredacted');
  }
  return text;
}

export function parseHostedMemberLogPageRequest(
  value: unknown
): HostedMemberLogParseResult<HostedMemberLogPageRequest> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PAGE_REQUEST_KEYS)) return failure();
    const schemaVersion = value.schemaVersion;
    const cursorValue = value.cursor;
    const generationValue = value.expectedSourceGeneration;
    const limit = value.limit;
    if (
      schemaVersion !== HOSTED_MEMBER_LOG_SCHEMA_VERSION ||
      !safeIntegerInRange(limit, 1, HOSTED_MEMBER_LOG_MAX_PAGE_ITEMS)
    ) {
      return failure();
    }
    const cursor = cursorValue === null ? null : parseCursor(cursorValue);
    const expectedSourceGeneration =
      generationValue === null ? null : parseHostedMemberLogSourceGeneration(generationValue);
    if ((cursor === null) !== (expectedSourceGeneration === null)) return failure();
    return success(
      Object.freeze({
        schemaVersion,
        selectionId: parseHostedMemberLogSelectionId(value.selectionId),
        cursor,
        expectedSourceGeneration,
        limit,
      })
    );
  } catch {
    return failure();
  }
}

export function parseHostedMemberLogEntry(
  value: unknown,
  expectedTeamId: TeamId,
  expectedMemberId: MemberId
): HostedMemberLogEntry {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) {
    throw new TypeError('hosted-member-log-entry-invalid');
  }
  const teamId = parseTeamId(value.teamId);
  const memberId = parseMemberId(value.memberId);
  const level = value.level;
  const occurredAtMs = value.occurredAtMs;
  if (
    teamId !== expectedTeamId ||
    memberId !== expectedMemberId ||
    !HOSTED_MEMBER_LOG_LEVELS.includes(level as HostedMemberLogLevel) ||
    !safeIntegerInRange(occurredAtMs, 0, Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError('hosted-member-log-entry-invalid');
  }
  return Object.freeze({
    teamId,
    memberId,
    entryId: parseHostedMemberLogEntryId(value.entryId),
    level: level as HostedMemberLogLevel,
    occurredAtMs,
    text: parseHostedMemberLogText(value.text),
  });
}

/** Normalizes untrusted source text before the result can cross into the HTTP adapter. */
export function redactHostedMemberLogEntry(
  value: unknown,
  expectedTeamId: TeamId,
  expectedMemberId: MemberId
): HostedMemberLogEntry {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) {
    throw new TypeError('hosted-member-log-entry-invalid');
  }
  return parseHostedMemberLogEntry(
    Object.freeze({ ...value, text: redactHostedMemberLogText(value.text) }),
    expectedTeamId,
    expectedMemberId
  );
}

export function hostedMemberLogJsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new TypeError('hosted-member-log-json-value-invalid');
  }
  return textEncoder.encode(serialized).byteLength;
}

/** Measures an entry only; page admission uses `hostedMemberLogPageByteLength` instead. */
export function hostedMemberLogEntryByteLength(entry: HostedMemberLogEntry): number {
  return hostedMemberLogJsonByteLength(entry);
}

/** Measures the exact JSON envelope admitted by the hosted response byte budget. */
export function hostedMemberLogPageByteLength(page: HostedMemberLogPage): number {
  return hostedMemberLogJsonByteLength(page);
}

function parseBudget(
  value: unknown,
  itemCount: number,
  requestLimit: number
): HostedMemberLogPageBudget {
  if (!isRecord(value)) throw new TypeError('hosted-member-log-page-budget-invalid');
  const itemLimit = value.itemLimit;
  const byteLimit = value.byteLimit;
  const timeLimitMs = value.timeLimitMs;
  const usedItems = value.usedItems;
  const usedBytes = value.usedBytes;
  const elapsedMs = value.elapsedMs;
  if (
    !hasExactKeys(value, BUDGET_KEYS) ||
    itemLimit !== requestLimit ||
    byteLimit !== HOSTED_MEMBER_LOG_MAX_PAGE_BYTES ||
    timeLimitMs !== HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS ||
    usedItems !== itemCount ||
    !safeIntegerInRange(usedItems, 0, requestLimit) ||
    !safeIntegerInRange(usedBytes, 0, HOSTED_MEMBER_LOG_MAX_PAGE_BYTES) ||
    !safeIntegerInRange(elapsedMs, 0, HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS)
  ) {
    throw new TypeError('hosted-member-log-page-budget-invalid');
  }
  return Object.freeze({
    itemLimit: requestLimit,
    byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
    timeLimitMs: HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
    usedItems: itemCount,
    usedBytes,
    elapsedMs,
  });
}

export function parseHostedMemberLogPage(
  value: unknown,
  request: HostedMemberLogPageRequest
): HostedMemberLogParseResult<HostedMemberLogPage> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, PAGE_KEYS) ||
      value.schemaVersion !== HOSTED_MEMBER_LOG_SCHEMA_VERSION ||
      value.kind !== 'member_log_page' ||
      parseHostedMemberLogSelectionId(value.selectionId) !== request.selectionId ||
      typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.entries) ||
      value.entries.length > request.limit ||
      !Array.isArray(value.truncationReasons) ||
      value.truncationReasons.length > HOSTED_MEMBER_LOG_TRUNCATION_REASONS.length ||
      new Set(value.truncationReasons).size !== value.truncationReasons.length ||
      !value.truncationReasons.every((reason) =>
        HOSTED_MEMBER_LOG_TRUNCATION_REASONS.includes(reason as HostedMemberLogTruncationReason)
      )
    ) {
      return failure();
    }
    for (let index = 0; index < value.entries.length; index += 1) {
      if (!Object.hasOwn(value.entries, index)) return failure();
    }
    const teamId = parseTeamId(value.teamId);
    const memberId = parseMemberId(value.memberId);
    const sourceGeneration = parseHostedMemberLogSourceGeneration(value.sourceGeneration);
    if (
      request.expectedSourceGeneration !== null &&
      sourceGeneration !== request.expectedSourceGeneration
    ) {
      return failure();
    }
    const entries = value.entries.map((entry) =>
      parseHostedMemberLogEntry(entry, teamId, memberId)
    );
    if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) return failure();
    const nextCursor = value.nextCursor === null ? null : parseCursor(value.nextCursor);
    const truncationReasons = Object.freeze([
      ...(value.truncationReasons as HostedMemberLogTruncationReason[]),
    ]);
    if (
      value.truncated !== (nextCursor !== null) ||
      value.truncated !== truncationReasons.length > 0 ||
      (nextCursor !== null && entries.length === 0) ||
      (nextCursor !== null && nextCursor === request.cursor)
    ) {
      return failure();
    }
    const budget = parseBudget(value.budget, entries.length, request.limit);
    const page = Object.freeze({
      schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
      kind: 'member_log_page' as const,
      selectionId: request.selectionId,
      teamId,
      memberId,
      sourceGeneration,
      revision: parseRevision(value.revision),
      entries: Object.freeze(entries),
      nextCursor,
      truncated: value.truncated,
      truncationReasons,
      budget,
    });
    const measuredBytes = hostedMemberLogPageByteLength(page);
    if (measuredBytes > HOSTED_MEMBER_LOG_MAX_PAGE_BYTES || budget.usedBytes !== measuredBytes) {
      return failure();
    }
    return success(page);
  } catch {
    return failure();
  }
}

export function parseHostedMemberLogErrorEnvelope(
  value: unknown
): HostedMemberLogParseResult<HostedMemberLogErrorEnvelope> {
  try {
    if (!isRecord(value)) return failure();
    if (
      value.schemaVersion !== HOSTED_MEMBER_LOG_SCHEMA_VERSION ||
      value.kind !== 'error' ||
      typeof value.retryable !== 'boolean' ||
      !ERROR_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== 'string' ||
          !ERROR_ALLOWED_KEYS.includes(key as (typeof ERROR_ALLOWED_KEYS)[number])
      )
    ) {
      return failure();
    }
    const currentSourceGeneration = Object.hasOwn(value, 'currentSourceGeneration')
      ? parseHostedMemberLogSourceGeneration(value.currentSourceGeneration)
      : undefined;
    return success(
      Object.freeze({
        schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
        kind: 'error',
        error: createSafeAppError(value.error),
        retryable: value.retryable,
        ...(currentSourceGeneration === undefined ? {} : { currentSourceGeneration }),
      })
    );
  } catch {
    return failure();
  }
}
