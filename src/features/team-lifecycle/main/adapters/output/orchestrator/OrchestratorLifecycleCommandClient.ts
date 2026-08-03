import { createConnection } from 'node:net';
import { isAbsolute, normalize } from 'node:path';

import {
  parseBootId,
  parseRevision,
  type QueryContext,
  type Revision,
} from '@shared/contracts/hosted';

import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  HOSTED_LIFECYCLE_CONFLICT_REASONS,
  type HostedLifecycleCommand,
  type HostedLifecycleConflictReason,
  parseHostedLifecycleCommandPublicResult,
} from '../../../../contracts/hosted-lifecycle-commands';
import {
  type HostedLifecycleAuthorizationGeneration,
  type HostedLifecycleCommandAuthorization,
  type HostedLifecycleCommandAuthorizationResult,
  type HostedLifecycleCommandGatewayExecutionResult,
  type HostedLifecycleCommandGatewayPort,
  type HostedLifecycleCommandRevalidationResult,
  type HostedLifecycleGrantId,
} from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';

import type { Socket } from 'node:net';

const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const GRANT_ID_PATTERN = /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const AUTHORIZATION_GENERATION_PATTERN =
  /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

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

function parseRetryAfterMs(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 60_000) {
    throw new TypeError('orchestrator-lifecycle-retry-after-invalid');
  }
  return value as number;
}

function parseGrantId(value: unknown): HostedLifecycleGrantId {
  if (typeof value !== 'string' || !GRANT_ID_PATTERN.test(value)) {
    throw new TypeError('orchestrator-lifecycle-grant-id-invalid');
  }
  return value as HostedLifecycleGrantId;
}

function parseAuthorizationGeneration(value: unknown): HostedLifecycleAuthorizationGeneration {
  if (typeof value !== 'string' || !AUTHORIZATION_GENERATION_PATTERN.test(value)) {
    throw new TypeError('orchestrator-lifecycle-authorization-generation-invalid');
  }
  return value as HostedLifecycleAuthorizationGeneration;
}

function parseAuthorization(value: unknown): HostedLifecycleCommandAuthorization {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['grantId', 'authorizationGeneration', 'bootId', 'resourceRevision'])
  ) {
    throw new TypeError('orchestrator-lifecycle-authorization-invalid');
  }
  return Object.freeze({
    grantId: parseGrantId(value.grantId),
    authorizationGeneration: parseAuthorizationGeneration(value.authorizationGeneration),
    bootId: parseBootId(value.bootId),
    resourceRevision: parseRevision(value.resourceRevision),
  });
}

function parseConflict(value: Record<PropertyKey, unknown>): {
  readonly kind: 'conflict';
  readonly reason: HostedLifecycleConflictReason;
  readonly currentRevision: Revision | null;
} {
  if (
    !hasExactKeys(value, ['schemaVersion', 'kind', 'reason', 'currentRevision']) ||
    value.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION ||
    !HOSTED_LIFECYCLE_CONFLICT_REASONS.includes(value.reason as HostedLifecycleConflictReason)
  ) {
    throw new TypeError('orchestrator-lifecycle-conflict-invalid');
  }
  return Object.freeze({
    kind: 'conflict',
    reason: value.reason as HostedLifecycleConflictReason,
    currentRevision: value.currentRevision === null ? null : parseRevision(value.currentRevision),
  });
}

function parseAuthorizationResponse(value: unknown): HostedLifecycleCommandAuthorizationResult {
  if (!isRecord(value) || value.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-authorization-response-invalid');
  }
  if (value.kind === 'authorized') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'authorization'])) throw new TypeError();
    return Object.freeze({
      kind: 'authorized',
      authorization: parseAuthorization(value.authorization),
    });
  }
  if (value.kind === 'conflict') return parseConflict(value);
  if (value.kind === 'not_found') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind'])) throw new TypeError();
    return Object.freeze({ kind: 'not_found' });
  }
  if (value.kind === 'unavailable') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])) throw new TypeError();
    return Object.freeze({
      kind: 'unavailable',
      retryAfterMs: parseRetryAfterMs(value.retryAfterMs),
    });
  }
  throw new TypeError('orchestrator-lifecycle-authorization-response-invalid');
}

function parseRevalidationResponse(value: unknown): HostedLifecycleCommandRevalidationResult {
  if (!isRecord(value) || value.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-revalidation-response-invalid');
  }
  if (value.kind === 'valid') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'authorization'])) throw new TypeError();
    return Object.freeze({ kind: 'valid', authorization: parseAuthorization(value.authorization) });
  }
  if (value.kind === 'conflict') return parseConflict(value);
  if (value.kind === 'not_found') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind'])) throw new TypeError();
    return Object.freeze({ kind: 'not_found' });
  }
  if (value.kind === 'unavailable') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])) throw new TypeError();
    return Object.freeze({
      kind: 'unavailable',
      retryAfterMs: parseRetryAfterMs(value.retryAfterMs),
    });
  }
  throw new TypeError('orchestrator-lifecycle-revalidation-response-invalid');
}

function parseExecutionResponse(value: unknown): HostedLifecycleCommandGatewayExecutionResult {
  if (!isRecord(value) || value.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-execution-response-invalid');
  }
  if (value.kind === 'result') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'result', 'authorization'])) {
      throw new TypeError();
    }
    const result = parseHostedLifecycleCommandPublicResult(value.result);
    if (!result.ok) throw new TypeError();
    return Object.freeze({
      kind: 'result',
      result: result.value,
      authorization: parseAuthorization(value.authorization),
    });
  }
  if (value.kind === 'unavailable') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])) throw new TypeError();
    return Object.freeze({
      kind: 'unavailable',
      retryAfterMs: parseRetryAfterMs(value.retryAfterMs),
    });
  }
  throw new TypeError('orchestrator-lifecycle-execution-response-invalid');
}

function serializeContext(context: QueryContext) {
  return Object.freeze({
    actorId: context.actorId,
    sessionId: context.sessionId,
    deploymentId: context.deploymentId,
    bootId: context.bootId,
    requestId: context.requestId,
    authorizedScope: context.authorizedScope,
    deadlineAtMs: context.deadlineAtMs,
  });
}

function validateSocketPath(socketPath: string): string {
  if (
    typeof socketPath !== 'string' ||
    socketPath.length < 1 ||
    socketPath.includes('\0') ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath) > 103
  ) {
    throw new TypeError('orchestrator-lifecycle-socket-path-invalid');
  }
  return socketPath;
}

export interface OrchestratorLifecycleCommandClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}

/** Thin newline-JSON ACL client. It owns transport only and never starts a provider or process. */
export class OrchestratorLifecycleCommandClient implements HostedLifecycleCommandGatewayPort {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly activeSockets = new Set<Socket>();
  private closed = false;

  constructor(options: OrchestratorLifecycleCommandClientOptions) {
    this.socketPath = validateSocketPath(options.socketPath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new TypeError('orchestrator-lifecycle-timeout-invalid');
    }
  }

  authorize(
    command: HostedLifecycleCommand,
    context: QueryContext
  ): Promise<HostedLifecycleCommandAuthorizationResult> {
    return this.request(
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        operation: 'authorize',
        command,
        context: serializeContext(context),
      }),
      context.signal,
      parseAuthorizationResponse
    );
  }

  revalidate(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandRevalidationResult> {
    return this.request(
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        operation: 'revalidate',
        command,
        authorization,
        context: serializeContext(context),
      }),
      context.signal,
      parseRevalidationResponse
    );
  }

  execute(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandGatewayExecutionResult> {
    return this.request(
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        operation: 'execute',
        command,
        authorization,
        context: serializeContext(context),
      }),
      context.signal,
      parseExecutionResponse
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
  }

  private request<Value>(
    message: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    parse: (value: unknown) => Value
  ): Promise<Value> {
    if (this.closed || signal.aborted) {
      return Promise.reject(new Error('orchestrator-lifecycle-client-unavailable'));
    }
    const body = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(body) > MAXIMUM_MESSAGE_BYTES) {
      return Promise.reject(new Error('orchestrator-lifecycle-request-too-large'));
    }

    return new Promise<Value>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      this.activeSockets.add(socket);
      let response = '';
      let responseBytes = 0;
      let settled = false;

      const finish = (error: unknown, value?: Value): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        this.activeSockets.delete(socket);
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(value as Value);
      };
      const abort = (): void => finish(new Error('orchestrator-lifecycle-request-cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      socket.setEncoding('utf8');
      socket.setTimeout(this.timeoutMs, () =>
        finish(new Error('orchestrator-lifecycle-request-timeout'))
      );
      socket.once('connect', () => socket.write(body));
      socket.once('error', () => finish(new Error('orchestrator-lifecycle-unavailable')));
      socket.on('data', (chunk: string) => {
        if (settled) return;
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAXIMUM_MESSAGE_BYTES) {
          finish(new Error('orchestrator-lifecycle-response-too-large'));
          return;
        }
        response += chunk;
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        if (response.slice(newline + 1).trim().length !== 0) {
          finish(new Error('orchestrator-lifecycle-response-invalid'));
          return;
        }
        try {
          finish(null, parse(JSON.parse(response.slice(0, newline))));
        } catch {
          finish(new Error('orchestrator-lifecycle-response-invalid'));
        }
      });
      socket.once('close', () => {
        if (!settled) finish(new Error('orchestrator-lifecycle-response-incomplete'));
      });
    });
  }
}
