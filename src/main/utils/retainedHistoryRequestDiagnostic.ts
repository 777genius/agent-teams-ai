import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { createLogger } from '@shared/utils/logger';

const TAIL_LIMIT = 64 * 1024;
const LINE_LIMIT = 512;
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g');
const KINDS = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
  'SQLiteError', 'OpenCodeAuthorityVetoError', 'AbortError', 'AggregateError']);
const CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EMFILE',
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CANTOPEN', 'SQLITE_READONLY',
  'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_SCHEMA', 'SQLITE_IOERR', 'SQLITE_MISUSE']);
const V2_REASONS = new Set(['v2_transcript_identity_invalid', 'v2_transcript_version_unsupported',
  'v2_transcript_original_owner_unavailable', 'v2_transcript_limit_invalid',
  'v2_transcript_response_invalid', 'v2_transcript_version_changed']);
const REASONS: readonly (readonly [string, RegExp])[] = [
  ['mcp_child_environment_invalid', /^Agent Teams MCP child environment must be a JSON object of strings$/],
  ['mcp_child_context_foreign', /^Foreign Host MCP child context$/],
  ['mcp_child_root_foreign', /^Foreign Host MCP child root$/],
  ['profile_authority_unavailable', /^OpenCode strict profile authority source is unavailable$/],
  ['profile_authentication_unavailable', /^OpenCode strict profile selected authentication is unavailable$/],
  ['profile_authentication_required', /^OpenCode strict profile requires explicit selected authentication \([^()\r\n]*\)$/],
  ['profile_snapshot_missing', /^OpenCode scoped profile preparation requires an exact resolver-issued snapshot$/],
  ['profile_snapshot_mismatch', /^OpenCode scoped profile preparation token does not match its snapshot$/],
  ['profile_project_changed', /^OpenCode (?:scoped profile|prepared profile) canonical project path changed$/],
  ['profile_attachment_changed', /^OpenCode scoped profile canonical attachment root changed$/],
  ['session_stopped', /^OpenCode session is stopped; launch a new run$/],
  ['session_authority_stale', /^OpenCode selected session authority is stale or unavailable; relaunch the lane$/],
  ['json_object_missing', /^No JSON object found in CLI output$/],
  ['invalid_time_value', /^Invalid time value$/],
  ['module_unavailable', /^(?:Cannot find (?:module|package)|Module not found|Could not resolve)(?:\s|:)/],
  ['sqlite_cannot_open', /^(?:unable to open database(?: file)?|cannot open database)$/i],
  ['sqlite_locked', /^(?:database(?: table| schema)? is locked|database is busy)$/i],
  ['sqlite_readonly', /^attempt to write a readonly database$/i],
  ['sqlite_corrupt', /^database disk image is malformed$/i],
  ['sqlite_not_database', /^file is not a database$/i],
  ['sqlite_schema_missing', /^no such (?:table|column):/i],
];
const SQLITE_REASONS: Readonly<Record<string, string>> = {
  SQLITE_BUSY: 'sqlite_locked', SQLITE_LOCKED: 'sqlite_locked', SQLITE_CANTOPEN: 'sqlite_cannot_open',
  SQLITE_READONLY: 'sqlite_readonly', SQLITE_CORRUPT: 'sqlite_corrupt', SQLITE_NOTADB: 'sqlite_not_database',
  SQLITE_SCHEMA: 'sqlite_schema_changed', SQLITE_IOERR: 'sqlite_io_error', SQLITE_MISUSE: 'sqlite_misuse',
};
const JS_REASONS: Readonly<Record<string, string>> = {
  TypeError: 'js_type_error', ReferenceError: 'js_reference_error', SyntaxError: 'js_syntax_error',
  RangeError: 'js_range_error', SQLiteError: 'sqlite_error', AbortError: 'aborted', AggregateError: 'aggregate_error',
};
const knownCode = (value: unknown): string | null =>
  typeof value === 'string' && CODES.has(value) ? value : null;
const kindOf = (value: unknown): string =>
  typeof value === 'string' && KINDS.has(value) ? value : 'unknown';
const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : undefined;
function reasonFor(message: string, kind: string, code: string | null): string {
  if (code && message.startsWith(code + ':')) message = message.slice(code.length + 1).trim();
  if (V2_REASONS.has(message)) return message;
  const authority = /^OpenCode authority is unknown; operation vetoed and store preserved \((host|session)\/(unreadable|nonregular|invalid)\)$/.exec(message);
  if (authority) return 'authority_' + authority[1] + '_' + authority[2];
  for (const [reason, pattern] of REASONS) if (pattern.test(message)) return reason;
  return (code && SQLITE_REASONS[code]) || JS_REASONS[kind] || 'unclassified';
}
function terminal(raw: string) {
  const truncated = raw.length > TAIL_LIMIT;
  let tail = raw.slice(-TAIL_LIMIT);
  if (truncated) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '';
  let kind = 'unknown', message = '', code: string | null = null, errno: number | null = null;
  let found = false;
  for (const rawLine of tail.split(/\r?\n/)) {
    if (rawLine.length > LINE_LIMIT) continue;
    const line = rawLine.replace(ANSI, '').trim();
    if (/^(?:\d+\s*[|:]|[>|]|at\s)/.test(line)) continue;
    const header = /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|SQLiteError|OpenCodeAuthorityVetoError|AbortError|AggregateError|error):\s*(.*)$/.exec(line);
    if (header) {
      found = true; kind = header[1] === 'error' ? 'Error' : (header[1] ?? 'unknown'); message = header[2] ?? '';
      code = knownCode(/^([A-Z][A-Z0-9_]*)(?::|\s)/.exec(message)?.[1]); errno = null;
    } else if (found) {
      const codeLine = /^code:\s*["']?([A-Z][A-Z0-9_]*)["']?,?$/.exec(line);
      const errnoLine = /^errno:\s*(-?\d{1,9}),?$/.exec(line);
      if (codeLine) code = knownCode(codeLine[1]);
      if (errnoLine) errno = Number(errnoLine[1]);
    }
  }
  return { found, truncated, kind, code, errno, reason: reasonFor(message, kind, code) };
}

/** TEST branch only. No raw text, paths, argv, stack, or causes leave this boundary. */
export function summarizeRetainedHistoryError(error: unknown) {
  try {
    const row = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
    const stderr = asText(row.stderr), stdout = asText(row.stdout), message = asText(row.message);
    const kind = kindOf(row.name), code = knownCode(row.code);
    const scan = terminal(stderr || message || '');
    const localMessage = !stderr && message && message.length <= LINE_LIMIT && !/[\r\n]/.test(message)
      ? message : '';
    const signal = typeof row.signal === 'string' && /^SIG(?:TERM|KILL|INT|ABRT|SEGV|BUS|PIPE|HUP|QUIT|ALRM)$/.test(row.signal)
      ? row.signal : null;
    return {
      diagnosticAvailable: true, errorKind: kind, code: integer(row.code) ?? code,
      errno: integer(row.errno), signal, killed: typeof row.killed === 'boolean' ? row.killed : null,
      stdoutBytes: stdout === undefined ? null : Buffer.byteLength(stdout),
      stderrBytes: stderr === undefined ? null : Buffer.byteLength(stderr),
      terminalSource: stderr ? 'stderr' : message ? 'message' : 'none',
      terminalFound: scan.found, tailTruncated: scan.truncated, terminalKind: scan.kind,
      terminalCode: scan.code, terminalErrno: scan.errno,
      reason: scan.found ? scan.reason : reasonFor(localMessage, kind, code),
    };
  } catch {
    return { diagnosticAvailable: false, reason: 'diagnostic_unavailable' };
  }
}

const logger = createLogger('TEST:RetainedHistoryRequest');
type Identity = { teamName: string; memberName: string; laneId?: string; runId?: string; sessionId?: string };
type Event = 'binding_unavailable' | 'binary_unavailable' | 'binding_no_longer_current' |
  'source_failure' | 'bridge_failure';

/** Temporary observation only; never changes the original request's result or exception. */
export function recordRetainedHistoryDiagnostic(
  event: Event, identity: Identity, stage: string, error?: unknown
): void {
  try {
    const parts = [identity.teamName, identity.memberName, identity.laneId ?? ''];
    const hash = (value: string[]) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    logger.diagnostic({
      schema: 'TEST_RETAINED_HISTORY_REQUEST_V1', event, stage,
      identityKey: hash(parts),
      bindingKey: hash([...parts, identity.runId ?? '', identity.sessionId ?? '']),
      error: error === undefined ? null : summarizeRetainedHistoryError(error),
    });
  } catch {
    // Diagnostic failure must not change existing binding, fallback, execution or cleanup.
  }
}
