import { parseRunId } from '@shared/contracts/hosted';

import {
  RUNTIME_INGRESS_BEARER_MAX_LENGTH,
  RUNTIME_INGRESS_BEARER_MIN_LENGTH,
  RUNTIME_INGRESS_HTTP_BODY_LIMIT_BYTES,
  type RuntimeIngressHttpCommandBody,
  type RuntimeIngressHttpErrorBody,
  type RuntimeIngressHttpPreMaterializationSizeFence,
  type RuntimeIngressHttpRequest,
  type RuntimeIngressHttpResponse,
} from '../../../../contracts/runtime-ingress-http';
import {
  isRuntimeIngressSessionStateRecoverable,
  isRuntimeIngressVerb,
  parseRuntimeIngressAcknowledgementId,
  parseRuntimeIngressCommandId,
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressEffectRef,
  parseRuntimeIngressPresentedSecret,
  parseRuntimeIngressRuntimeInstanceId,
  type PresentedRuntimeIngressCredential,
  type RuntimeIngressCredential,
  type RuntimeIngressSessionState,
} from '../../../../core/domain/runtime-ingress';

import { RuntimeIngressRateLimiter } from './RuntimeIngressRateLimiter';

import type {
  ExecuteRuntimeIngress,
  ExecuteRuntimeIngressOutcome,
  RuntimeIngressCommandOrchestrationPort,
  RuntimeIngressRelayCommandRequest,
  RuntimeIngressRelayCommandResult,
} from '../../../../core/application/runtime-ingress';

const EXACT_BODY_KEYS = Object.freeze([
  'runtimeInstanceId',
  'commandId',
  'sequence',
  'observedAtIso',
  'payload',
] as const);
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'authority',
  'cwd',
  'rawCwd',
  'teamName',
  'teamId',
  'runId',
  'laneId',
  'providerId',
  'deploymentId',
  'topology',
  'expectedMembers',
  'memberDefinitions',
  'previousLaunchState',
  'credential',
  'credentialId',
  'credentialGeneration',
  'sessionId',
  'deliveryOwnerId',
]);
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 2_048;
const MAX_JSON_STRING_LENGTH = 16 * 1024;
const CONTENT_TYPE = 'application/json';
const NO_STORE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
});

export interface RuntimeIngressCredentialContext {
  readonly credential: RuntimeIngressCredential;
  readonly session: RuntimeIngressSessionState;
}

export interface RuntimeIngressCredentialContextPort {
  resolveCredentialContext(
    presented: PresentedRuntimeIngressCredential
  ): Promise<
    | { readonly status: 'resolved'; readonly context: RuntimeIngressCredentialContext }
    | { readonly status: 'rejected' | 'unavailable' }
  >;
}

export interface RuntimeIngressHttpInputAdapterDeps {
  readonly executeRuntimeIngress: ExecuteRuntimeIngress;
  readonly credentialContext: RuntimeIngressCredentialContextPort;
  readonly rateLimiter: RuntimeIngressRateLimiter;
  readonly nextRequestId: () => string;
  readonly bodyLimitBytes?: number;
}

export class RuntimeIngressHttpInputAdapter implements RuntimeIngressCommandOrchestrationPort {
  private readonly bodyLimitBytes: number;
  readonly preMaterializationSizeFence: RuntimeIngressHttpPreMaterializationSizeFence;

  constructor(private readonly deps: RuntimeIngressHttpInputAdapterDeps) {
    this.bodyLimitBytes = deps.bodyLimitBytes ?? RUNTIME_INGRESS_HTTP_BODY_LIMIT_BYTES;
    if (!Number.isSafeInteger(this.bodyLimitBytes) || this.bodyLimitBytes < 1) {
      throw new TypeError('runtime-ingress-http-body-limit-invalid');
    }
    this.preMaterializationSizeFence = Object.freeze({
      maximumBodyBytes: this.bodyLimitBytes,
      overflowStatusCode: 413,
      rejectBeforeBodyMaterialization: true,
    });
  }

  async handle(request: RuntimeIngressHttpRequest): Promise<RuntimeIngressHttpResponse> {
    const requestId = safeRequestId(this.deps.nextRequestId());
    const contentType = readSingleHeader(request.contentTypeHeader);
    const contentLength = parseContentLength(request.contentLengthHeader);
    if (contentType !== CONTENT_TYPE || contentLength === 'invalid') {
      return errorResponse(requestId, 400, 'runtime_ingress_bad_request', false);
    }
    if (contentLength !== null && contentLength > this.bodyLimitBytes) {
      return errorResponse(requestId, 413, 'runtime_ingress_payload_too_large', false);
    }
    const transportBytes = rawTransportByteLength(request.rawBody);
    if (transportBytes === null) {
      return errorResponse(requestId, 400, 'runtime_ingress_bad_request', false);
    }
    if (transportBytes > this.bodyLimitBytes) {
      return errorResponse(requestId, 413, 'runtime_ingress_payload_too_large', false);
    }
    if (contentLength !== null && contentLength !== transportBytes) {
      return errorResponse(requestId, 400, 'runtime_ingress_bad_request', false);
    }

    const credentialId = readSingleHeader(request.credentialIdHeader);
    const authorization = readSingleHeader(request.authorizationHeader);
    const presented = parseAuthorization(credentialId, authorization);
    if (!presented) return errorResponse(requestId, 401, 'runtime_ingress_unauthorized', false);

    const globalRate = this.deps.rateLimiter.admitGlobal();
    if (!globalRate.admitted) {
      return errorResponse(
        requestId,
        429,
        'runtime_ingress_rate_limited',
        true,
        globalRate.retryAfterSeconds
      );
    }

    const resolved = await this.resolveCredentialContext(presented);
    if (resolved.status !== 'resolved') {
      return errorResponse(
        requestId,
        resolved.status === 'unavailable' ? 503 : 401,
        resolved.status === 'unavailable'
          ? 'runtime_ingress_unavailable'
          : 'runtime_ingress_unauthorized',
        resolved.status === 'unavailable'
      );
    }
    const { credential, session } = resolved.context;
    const credentialRate = this.deps.rateLimiter.admitCredential(credential.credentialId);
    if (!credentialRate.admitted) {
      return errorResponse(
        requestId,
        429,
        'runtime_ingress_rate_limited',
        true,
        credentialRate.retryAfterSeconds
      );
    }

    let pathRunId: ReturnType<typeof parseRunId>;
    try {
      pathRunId = parseRunId(request.runId);
    } catch {
      return errorResponse(requestId, 400, 'runtime_ingress_bad_request', false);
    }
    if (
      !isRuntimeIngressVerb(request.verb) ||
      pathRunId !== credential.scope.runId ||
      !credential.scope.allowedVerbs.includes(request.verb)
    ) {
      return errorResponse(requestId, 403, 'runtime_ingress_scope_mismatch', false);
    }

    const rawBody = decodeBody(request.rawBody);
    if (rawBody === null) {
      return errorResponse(requestId, 400, 'runtime_ingress_bad_request', false);
    }
    const body = parseCommandBody(rawBody);
    if (!body) return errorResponse(requestId, 400, 'runtime_ingress_bad_request', false);

    const outcome = await this.deps.executeRuntimeIngress.execute({
      authority: {
        deploymentId: credential.scope.deploymentId,
        teamId: credential.scope.teamId,
        runId: credential.scope.runId,
        planGeneration: credential.scope.planGeneration,
        laneId: credential.scope.laneId,
        providerId: credential.scope.providerId,
        credentialGeneration: credential.scope.credentialGeneration,
        verb: request.verb,
      },
      presentedCredential: presented,
      sessionId: credential.sessionId,
      runtimeInstanceId: parseRuntimeIngressRuntimeInstanceId(body.runtimeInstanceId),
      deliveryOwnerId: session.deliveryOwnerId,
      commandId: parseRuntimeIngressCommandId(body.commandId),
      sequence: body.sequence,
      observedAtIso: body.observedAtIso,
      effect: { payloadJson: stableCanonicalJson(body.payload) },
    });
    return mapOutcome(requestId, outcome);
  }

  async executeRelayCommand(
    request: RuntimeIngressRelayCommandRequest
  ): Promise<RuntimeIngressRelayCommandResult> {
    const response = await this.handle({
      runId: request.runId,
      verb: request.verb,
      credentialIdHeader: request.credentialId,
      authorizationHeader: `Bearer ${request.presentedSecret}`,
      contentTypeHeader: CONTENT_TYPE,
      contentLengthHeader: String(rawTransportByteLength(request.rawBody)),
      rawBody: request.rawBody,
    });
    if ('status' in response.body) {
      return {
        status: response.body.status,
        acknowledgementId: parseRuntimeIngressAcknowledgementId(response.body.acknowledgementId),
        effectRef: parseRuntimeIngressEffectRef(response.body.effectRef),
        acceptedAtIso: response.body.acceptedAtIso,
      };
    }
    return {
      status: 'rejected',
      reason: mapRelayError(response.body.error.code),
      ...(response.headers['retry-after'] === undefined
        ? {}
        : { retryAfterSeconds: Number(response.headers['retry-after']) }),
    };
  }

  private async resolveCredentialContext(
    presented: PresentedRuntimeIngressCredential
  ): ReturnType<RuntimeIngressCredentialContextPort['resolveCredentialContext']> {
    try {
      const resolved = await this.deps.credentialContext.resolveCredentialContext(presented);
      if (
        resolved.status === 'resolved' &&
        (!isRuntimeIngressSessionStateRecoverable(resolved.context.session) ||
          resolved.context.credential.phase !== 'active' ||
          resolved.context.credential.credentialId !== presented.credentialId)
      ) {
        return { status: 'rejected' };
      }
      return resolved;
    } catch {
      return { status: 'unavailable' };
    }
  }
}

function parseAuthorization(
  credentialIdValue: string | null,
  authorization: string | null
): PresentedRuntimeIngressCredential | null {
  if (!credentialIdValue || !authorization?.startsWith('Bearer ')) return null;
  const secretValue = authorization.slice('Bearer '.length);
  if (
    secretValue.length < RUNTIME_INGRESS_BEARER_MIN_LENGTH ||
    secretValue.length > RUNTIME_INGRESS_BEARER_MAX_LENGTH ||
    secretValue.trim() !== secretValue
  ) {
    return null;
  }
  try {
    return Object.freeze({
      credentialId: parseRuntimeIngressCredentialId(credentialIdValue),
      secret: parseRuntimeIngressPresentedSecret(secretValue),
    });
  } catch {
    return null;
  }
}

function parseCommandBody(rawBody: string): RuntimeIngressHttpCommandBody | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (!hasExactKeys(value, EXACT_BODY_KEYS) || !isPlainObject(value.payload)) return null;
  try {
    parseRuntimeIngressRuntimeInstanceId(value.runtimeInstanceId);
    parseRuntimeIngressCommandId(value.commandId);
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.observedAtIso !== 'string' ||
    !isBoundedCanonicalPayload(value.payload)
  ) {
    return null;
  }
  return value as unknown as RuntimeIngressHttpCommandBody;
}

function isBoundedCanonicalPayload(value: Readonly<Record<string, unknown>>): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) return false;
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_JSON_STRING_LENGTH) return false;
      continue;
    }
    if (typeof current.value !== 'object' || seen.has(current.value)) return false;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (FORBIDDEN_AUTHORITY_KEYS.has(key)) return false;
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

function stableCanonicalJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: sortJson(value[key]),
    });
  }
  return sorted;
}

function mapOutcome(
  requestId: string,
  outcome: ExecuteRuntimeIngressOutcome
): RuntimeIngressHttpResponse {
  if (outcome.status !== 'rejected') {
    return {
      statusCode: outcome.status === 'accepted' ? 202 : 200,
      headers: { ...NO_STORE_HEADERS, 'x-request-id': requestId },
      body: {
        requestId,
        status: outcome.status,
        acknowledgementId: outcome.acknowledgement.acknowledgementId,
        effectRef: outcome.acknowledgement.effectRef,
        acceptedAtIso: outcome.acknowledgement.acceptedAtIso,
      },
    };
  }
  switch (outcome.reason) {
    case 'credential_invalid':
    case 'credential_scope_mismatch':
      return errorResponse(requestId, 401, 'runtime_ingress_unauthorized', false);
    case 'body_authority_mismatch':
    case 'delivery_owner_mismatch':
    case 'runtime_instance_mismatch':
    case 'session_scope_mismatch':
      return errorResponse(requestId, 403, 'runtime_ingress_scope_mismatch', false);
    case 'replay_conflict':
    case 'sequence_out_of_order':
    case 'event_out_of_order':
    case 'event_not_fresh':
    case 'bootstrap_required':
    case 'bootstrap_already_accepted':
      return errorResponse(requestId, 409, 'runtime_ingress_conflict', false);
    case 'recovery_required':
      return errorResponse(requestId, 503, 'runtime_ingress_recovery_required', false);
    case 'credential_unavailable':
    case 'session_unavailable':
    case 'storage_unavailable':
    case 'concurrency_conflict':
      return errorResponse(requestId, 503, 'runtime_ingress_unavailable', true);
    case 'protocol_invalid':
    case 'session_invalid':
      return errorResponse(requestId, 400, 'runtime_ingress_bad_request', false);
  }
}

function errorResponse(
  requestId: string,
  statusCode: 400 | 401 | 403 | 409 | 413 | 429 | 503,
  code:
    | 'runtime_ingress_bad_request'
    | 'runtime_ingress_unauthorized'
    | 'runtime_ingress_scope_mismatch'
    | 'runtime_ingress_conflict'
    | 'runtime_ingress_payload_too_large'
    | 'runtime_ingress_rate_limited'
    | 'runtime_ingress_recovery_required'
    | 'runtime_ingress_unavailable',
  retryable: boolean,
  retryAfterSeconds?: number
): RuntimeIngressHttpResponse {
  return {
    statusCode,
    headers: {
      ...NO_STORE_HEADERS,
      'x-request-id': requestId,
      ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
    },
    body: { requestId, error: { code, retryable } },
  };
}

function readSingleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseContentLength(
  value: string | readonly string[] | undefined
): number | null | 'invalid' {
  if (value === undefined) return null;
  const single = readSingleHeader(value);
  if (!single || !/^(0|[1-9]\d{0,9})$/.test(single)) return 'invalid';
  const parsed = Number(single);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

function decodeBody(value: string | Uint8Array): string | null {
  if (typeof value === 'string') return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

function rawTransportByteLength(value: unknown): number | null {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return value instanceof Uint8Array ? value.byteLength : null;
}

function mapRelayError(
  code: RuntimeIngressHttpErrorBody['error']['code']
): Extract<RuntimeIngressRelayCommandResult, { status: 'rejected' }>['reason'] {
  switch (code) {
    case 'runtime_ingress_bad_request':
      return 'bad_request';
    case 'runtime_ingress_unauthorized':
      return 'unauthorized';
    case 'runtime_ingress_scope_mismatch':
      return 'scope_mismatch';
    case 'runtime_ingress_conflict':
      return 'conflict';
    case 'runtime_ingress_payload_too_large':
      return 'payload_too_large';
    case 'runtime_ingress_rate_limited':
      return 'rate_limited';
    case 'runtime_ingress_recovery_required':
      return 'recovery_required';
    case 'runtime_ingress_unavailable':
      return 'unavailable';
  }
}

function safeRequestId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : 'runtime-request-invalid';
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T
): value is Record<T[number], unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
