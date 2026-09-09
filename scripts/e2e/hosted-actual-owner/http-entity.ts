import { exactRecord, sha256 } from './contracts';
import { freezeHttpData, httpCheck, httpHex, httpId } from './raw-http';
import type {
  HostedHttpOperation,
  HttpRequestObservation,
  HttpResponseObservation,
} from './raw-http-types';

const PROTOCOL = 'agent-teams-hosted-approval-v2';
const REPLY_KEYS = [
  'schemaVersion',
  'protocol',
  'runtimeInstanceId',
  'expectedConfigGeneration',
  'requestId',
  'sessionId',
  'sessionIncarnation',
  'requestIncarnation',
  'expectedPermissionDigest',
  'decision',
];
const RECEIPT_KEYS = [
  'schemaVersion',
  'protocol',
  'status',
  'runtimeInstanceId',
  'configGeneration',
  'requestId',
  'sessionId',
  'sessionIncarnation',
  'requestIncarnation',
  'permissionDigest',
  'decision',
];

/** Entity JSON is not canonical envelope JSON: actual OpenCode responses use JSON.stringify. */
export function parseHttpEntity(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  let offset = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(text[offset] ?? '')) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
      if (char === '\\') offset++;
    }
    throw new Error('p3c_http_entity_string');
  };
  const value = (): void => {
    whitespace();
    const char = text[offset];
    if (char === '"') {
      string();
      return;
    }
    if (char === '{' || char === '[') {
      offset++;
      whitespace();
      const end = char === '{' ? '}' : ']';
      if (text[offset] === end) {
        offset++;
        return;
      }
      const keys = new Set<string>();
      while (offset < text.length) {
        whitespace();
        if (char === '{') {
          const key = string();
          httpCheck(!keys.has(key), 'entity_duplicate_key');
          keys.add(key);
          whitespace();
          offset++; // Colon and all syntax have already been checked by JSON.parse.
        }
        value();
        whitespace();
        if (text[offset++] === end) return;
      }
    } else {
      while (offset < text.length && !/[\x20\t\r\n,}\]]/u.test(text[offset]!)) offset++;
    }
  };
  value();
  return freezeHttpData(parsed);
}

// OpenCode protocol.digest permits arbitrary finite JSON numbers in rawPermission metadata.
function canonicalEntity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEntity).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalEntity(item)}`)
      .join(',')}}`;
  }
  httpCheck(typeof value !== 'number' || Number.isFinite(value), 'entity_number');
  return JSON.stringify(value);
}

function pattern(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{32}$`, 'u').test(value);
}

function version(value: Record<string, unknown>): void {
  httpCheck(
    value.schemaVersion === 2 &&
      value.protocol === PROTOCOL &&
      pattern(value.runtimeInstanceId, 'runtime_instance') &&
      pattern(value.configGeneration, 'config_generation'),
    'entity_version'
  );
}

export type ConditionalRequest = Readonly<Record<string, unknown>>;
export type ConditionalRequestResult =
  | Readonly<{ kind: 'valid'; value: ConditionalRequest }>
  | Readonly<{ kind: 'invalid-json' | 'invalid-schema' | 'body-too-large' }>;

export function decodeConditionalRequest(
  request: HttpRequestObservation
): ConditionalRequestResult {
  if (request.body.byteLength > 16 * 1024) return { kind: 'body-too-large' };
  let value: unknown;
  try {
    value = parseHttpEntity(Buffer.from(request.body.bodyBase64, 'base64'));
  } catch {
    return { kind: 'invalid-json' };
  }
  try {
    const body = exactRecord(value, REPLY_KEYS, 'http_conditional_request');
    httpCheck(
      body.schemaVersion === 2 &&
        body.protocol === PROTOCOL &&
        pattern(body.runtimeInstanceId, 'runtime_instance') &&
        pattern(body.expectedConfigGeneration, 'config_generation') &&
        pattern(body.sessionIncarnation, 'session_incarnation') &&
        pattern(body.requestIncarnation, 'request_incarnation') &&
        typeof body.sessionId === 'string' &&
        typeof body.requestId === 'string' &&
        body.requestId.startsWith('per') &&
        httpHex(body.expectedPermissionDigest) &&
        ['allow_once', 'reject'].includes(body.decision as string),
      'conditional_request'
    );
    return { kind: 'valid', value: body };
  } catch {
    return { kind: 'invalid-schema' };
  }
}

export function assertSubmittedCondition(
  operation: Extract<HostedHttpOperation, { kind: 'reply' }>,
  body: ConditionalRequest
): void {
  for (const key of [
    'runtimeInstanceId',
    'sessionIncarnation',
    'requestIncarnation',
    'decision',
  ] as const) {
    httpCheck(body[key] === operation[key], 'submitted_condition');
  }
  httpCheck(
    body.expectedConfigGeneration === operation.configGeneration &&
      body.expectedPermissionDigest === operation.permissionDigest,
    'submitted_condition'
  );
  // URL IDs are intentionally not compared here: the actual typed bad-request branch differs.
}

export type AppliedHttpReceipt = Readonly<
  Omit<Extract<HostedHttpOperation, { kind: 'reply' }>, 'kind'> & {
    schemaVersion: 2;
    protocol: typeof PROTOCOL;
    status: 'applied';
  }
>;

export function appliedHttpReceipt(
  request: HttpRequestObservation,
  response: HttpResponseObservation
): AppliedHttpReceipt | null {
  if (
    request.operation.kind !== 'reply' ||
    !response.complete ||
    response.status !== 200 ||
    response.body.byteLength > 16 * 1024
  )
    return null;
  try {
    const decoded = decodeConditionalRequest(request);
    httpCheck(decoded.kind === 'valid', 'receipt_request');
    assertSubmittedCondition(request.operation, decoded.value);
    httpCheck(
      decoded.value.sessionId === request.operation.sessionId &&
        decoded.value.requestId === request.operation.requestId,
      'receipt_request_ids'
    );
    const body = exactRecord(
      parseHttpEntity(Buffer.from(response.body.bodyBase64, 'base64')),
      RECEIPT_KEYS,
      'http_receipt'
    );
    version(body);
    httpCheck(body.status === 'applied', 'receipt_status');
    for (const [key, value] of Object.entries(request.operation)) {
      if (key !== 'kind') httpCheck(body[key] === value, 'receipt_condition');
    }
    return body as AppliedHttpReceipt;
  } catch {
    return null;
  }
}

function permission(value: unknown, sessionId: string): void {
  const item = exactRecord(
    value,
    [
      'requestId',
      'sessionId',
      'sessionIncarnation',
      'requestIncarnation',
      'permissionDigest',
      'rawPermission',
    ],
    'http_permission'
  );
  httpCheck(
    httpId(item.requestId) &&
      item.requestId.startsWith('per') &&
      item.sessionId === sessionId &&
      pattern(item.sessionIncarnation, 'session_incarnation') &&
      pattern(item.requestIncarnation, 'request_incarnation') &&
      httpHex(item.permissionDigest) &&
      sha256(canonicalEntity(item.rawPermission)) === item.permissionDigest,
    'permission'
  );
  httpCheck(
    item.rawPermission !== null && typeof item.rawPermission === 'object',
    'permission_raw'
  );
  const raw = item.rawPermission as Record<string, unknown>;
  exactRecord(
    raw,
    [
      'id',
      'sessionID',
      'permission',
      'patterns',
      'metadata',
      'always',
      ...('tool' in raw ? ['tool'] : []),
    ],
    'http_permission_raw'
  );
  httpCheck(
    raw.id === item.requestId &&
      raw.sessionID === sessionId &&
      sessionId.startsWith('ses') &&
      typeof raw.permission === 'string' &&
      raw.metadata !== null &&
      typeof raw.metadata === 'object' &&
      !Array.isArray(raw.metadata),
    'permission_raw'
  );
  for (const key of ['patterns', 'always']) {
    httpCheck(
      Array.isArray(raw[key]) && raw[key].every((item) => typeof item === 'string'),
      'permission_array'
    );
  }
  if ('tool' in raw) {
    const tool = exactRecord(raw.tool, ['callID', 'messageID'], 'http_permission_tool');
    httpCheck(
      typeof tool.callID === 'string' && typeof tool.messageID === 'string',
      'permission_tool'
    );
  }
}

export function decodeReadResponse(
  operation: Exclude<HostedHttpOperation, { kind: 'reply' }>,
  response: HttpResponseObservation
): Readonly<Record<string, unknown>> {
  httpCheck(
    response.complete &&
      response.body.byteLength <= (operation.kind === 'capability' ? 16 * 1024 : 1024 * 1024),
    'read_response_limit'
  );
  httpCheck(operation.kind === 'capability' || operation.kind === 'observe', 'read_operation');
  const parsed = parseHttpEntity(Buffer.from(response.body.bodyBase64, 'base64'));
  if (operation.kind === 'observe' && response.status === 500) {
    const error = exactRecord(parsed, ['_tag'], 'http_observe_overflow');
    httpCheck(error._tag === 'InternalServerError', 'observe_overflow');
    return error;
  }
  const body = exactRecord(
    parsed,
    operation.kind === 'capability'
      ? ['schemaVersion', 'protocol', 'runtimeInstanceId', 'configGeneration', 'authentication']
      : [
          'schemaVersion',
          'protocol',
          'runtimeInstanceId',
          'configGeneration',
          'sessionId',
          'permissions',
        ],
    'http_read'
  );
  version(body);
  httpCheck(response.status === 200, 'read_status');
  if (operation.kind === 'capability') {
    httpCheck(body.authentication === 'opencode-basic', 'capability_auth');
  } else {
    httpCheck(
      body.sessionId === operation.sessionId &&
        Array.isArray(body.permissions) &&
        body.permissions.length <= 256,
      'observe'
    );
    body.permissions.forEach((item) => permission(item, operation.sessionId));
  }
  return body;
}
