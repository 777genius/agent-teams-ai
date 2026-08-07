import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { isAbsolute, normalize } from 'node:path';

import {
  parseActorId,
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
  type Revision,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  HOSTED_LIFECYCLE_CONFLICT_REASONS,
  type HostedLifecycleCommand,
  type HostedLifecycleConflictReason,
  type HostedLifecycleControlStateRequest,
  type HostedLifecycleControlStateResult,
  parseHostedLifecycleCommandPublicResult,
  parseHostedLifecycleControlState,
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
const EXCHANGE_ID_PATTERN = /^lifecycle-request_[0-9a-f]{32}$/;
type LifecycleOperation = 'control_state' | 'authorize' | 'revalidate' | 'execute';

interface LifecycleResponseAuthority {
  readonly actorId: QueryContext['actorId'];
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly deploymentId: QueryContext['deploymentId'];
  readonly restoreGeneration: number;
  readonly bootId: QueryContext['bootId'];
  readonly resourceRevision: Revision | null;
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

function parseRetryAfterMs(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 60_000) {
    throw new TypeError('orchestrator-lifecycle-retry-after-invalid');
  }
  return value as number;
}

function parseRestoreGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('orchestrator-lifecycle-restore-generation-invalid');
  }
  return value;
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

function serializeAuthority(
  context: QueryContext,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  restoreGeneration: number,
  resourceRevision: Revision | null
) {
  return Object.freeze({
    actorId: context.actorId,
    workspaceId,
    teamId,
    deploymentId: context.deploymentId,
    restoreGeneration,
    bootId: context.bootId,
    resourceRevision,
  });
}

function parseResponseAuthority(
  value: unknown,
  context: QueryContext,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  restoreGeneration: number
): LifecycleResponseAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'actorId',
      'workspaceId',
      'teamId',
      'deploymentId',
      'restoreGeneration',
      'bootId',
      'resourceRevision',
    ])
  ) {
    throw new TypeError('orchestrator-lifecycle-response-authority-invalid');
  }
  const authority = Object.freeze({
    actorId: parseActorId(value.actorId),
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    deploymentId: parseDeploymentId(value.deploymentId),
    restoreGeneration: parseRestoreGeneration(value.restoreGeneration),
    bootId: parseBootId(value.bootId),
    resourceRevision:
      value.resourceRevision === null ? null : parseRevision(value.resourceRevision),
  });
  if (
    authority.actorId !== context.actorId ||
    authority.workspaceId !== workspaceId ||
    authority.teamId !== teamId ||
    authority.deploymentId !== context.deploymentId ||
    authority.restoreGeneration !== restoreGeneration ||
    authority.bootId !== context.bootId
  ) {
    throw new TypeError('orchestrator-lifecycle-response-authority-scope-invalid');
  }
  return authority;
}

function requireAuthorityRevision(
  authority: LifecycleResponseAuthority,
  revision: Revision | null
): void {
  if (authority.resourceRevision !== revision) {
    throw new TypeError('orchestrator-lifecycle-response-authority-revision-invalid');
  }
}

function parseAuthorization(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number
): HostedLifecycleCommandAuthorization {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'grantId',
      'authorizationGeneration',
      'deploymentId',
      'bootId',
      'resourceRevision',
      'actorId',
      'workspaceId',
      'teamId',
      'restoreGeneration',
    ])
  ) {
    throw new TypeError('orchestrator-lifecycle-authorization-invalid');
  }
  const authorization = Object.freeze({
    grantId: parseGrantId(value.grantId),
    authorizationGeneration: parseAuthorizationGeneration(value.authorizationGeneration),
    deploymentId: parseDeploymentId(value.deploymentId),
    bootId: parseBootId(value.bootId),
    resourceRevision: parseRevision(value.resourceRevision),
    actorId: parseActorId(value.actorId),
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    restoreGeneration: parseRestoreGeneration(value.restoreGeneration),
  });
  if (
    authorization.actorId !== context.actorId ||
    authorization.workspaceId !== command.workspaceId ||
    authorization.teamId !== command.teamId ||
    authorization.deploymentId !== context.deploymentId ||
    authorization.bootId !== context.bootId ||
    authorization.restoreGeneration !== restoreGeneration
  ) {
    throw new TypeError('orchestrator-lifecycle-authorization-scope-invalid');
  }
  return authorization;
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

function parseAuthorizationResponse(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number
): HostedLifecycleCommandAuthorizationResult {
  if (!isRecord(value) || value.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-authorization-response-invalid');
  }
  if (value.kind === 'authorized') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'authorization'])) throw new TypeError();
    return Object.freeze({
      kind: 'authorized',
      authorization: parseAuthorization(value.authorization, command, context, restoreGeneration),
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

function parseRevalidationResponse(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number
): HostedLifecycleCommandRevalidationResult {
  if (!isRecord(value) || value.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION) {
    throw new TypeError('orchestrator-lifecycle-revalidation-response-invalid');
  }
  if (value.kind === 'valid') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'authorization'])) throw new TypeError();
    return Object.freeze({
      kind: 'valid',
      authorization: parseAuthorization(value.authorization, command, context, restoreGeneration),
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
  throw new TypeError('orchestrator-lifecycle-revalidation-response-invalid');
}

function parseExecutionResponse(
  value: unknown,
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number
): HostedLifecycleCommandGatewayExecutionResult {
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
      authorization: parseAuthorization(value.authorization, command, context, restoreGeneration),
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
  readonly restoreGeneration: number;
  readonly timeoutMs?: number;
  readonly generateExchangeId?: () => string;
  /** Test seam only; production always uses Node's Unix-socket connection factory. */
  readonly connect?: (options: { readonly path: string }) => Socket;
}

/** Thin newline-JSON ACL client. It owns transport only and never starts a provider or process. */
export class OrchestratorLifecycleCommandClient implements HostedLifecycleCommandGatewayPort {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly restoreGeneration: number;
  private readonly generateExchangeId: () => string;
  private readonly connect: (options: { readonly path: string }) => Socket;
  private readonly activeSockets = new Set<Socket>();
  private closed = false;

  constructor(options: OrchestratorLifecycleCommandClientOptions) {
    this.socketPath = validateSocketPath(options.socketPath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.restoreGeneration = parseRestoreGeneration(options.restoreGeneration);
    this.generateExchangeId =
      options.generateExchangeId ?? (() => `lifecycle-request_${randomUUID().replaceAll('-', '')}`);
    this.connect = options.connect ?? createConnection;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new TypeError('orchestrator-lifecycle-timeout-invalid');
    }
  }

  getControlState(
    request: HostedLifecycleControlStateRequest,
    context: QueryContext
  ): Promise<HostedLifecycleControlStateResult> {
    return this.request(
      'control_state',
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        operation: 'control_state',
        request,
        context: serializeContext(context),
        authority: serializeAuthority(
          context,
          request.workspaceId,
          request.teamId,
          this.restoreGeneration,
          null
        ),
      }),
      context,
      request.workspaceId,
      request.teamId,
      (value, authority) => {
        if (isRecord(value) && value.kind === 'control_state') {
          const parsed = parseHostedLifecycleControlState(value, {
            ...request,
            deploymentId: context.deploymentId,
            bootId: context.bootId,
          });
          if (parsed.ok) {
            requireAuthorityRevision(authority, parsed.value.resourceRevision);
            return parsed.value;
          }
        }
        if (
          isRecord(value) &&
          value.schemaVersion === HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION &&
          value.kind === 'not_found' &&
          hasExactKeys(value, ['schemaVersion', 'kind'])
        ) {
          requireAuthorityRevision(authority, null);
          return Object.freeze({
            schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
            kind: 'not_found' as const,
          });
        }
        if (
          isRecord(value) &&
          value.schemaVersion === HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION &&
          value.kind === 'unavailable' &&
          hasExactKeys(value, ['schemaVersion', 'kind', 'retryAfterMs'])
        ) {
          requireAuthorityRevision(authority, null);
          return Object.freeze({
            schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
            kind: 'unavailable' as const,
            retryAfterMs: parseRetryAfterMs(value.retryAfterMs),
          });
        }
        throw new TypeError('orchestrator-lifecycle-control-state-response-invalid');
      }
    );
  }

  authorize(
    command: HostedLifecycleCommand,
    context: QueryContext
  ): Promise<HostedLifecycleCommandAuthorizationResult> {
    return this.request(
      'authorize',
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        operation: 'authorize',
        command,
        context: serializeContext(context),
        authority: serializeAuthority(
          context,
          command.workspaceId,
          command.teamId,
          this.restoreGeneration,
          command.expectedRevision
        ),
      }),
      context,
      command.workspaceId,
      command.teamId,
      (value, authority) => {
        const result = parseAuthorizationResponse(value, command, context, this.restoreGeneration);
        requireAuthorityRevision(
          authority,
          result.kind === 'authorized'
            ? result.authorization.resourceRevision
            : result.kind === 'conflict'
              ? result.currentRevision
              : null
        );
        return result;
      }
    );
  }

  revalidate(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandRevalidationResult> {
    return this.request(
      'revalidate',
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        operation: 'revalidate',
        command,
        authorization,
        context: serializeContext(context),
        authority: serializeAuthority(
          context,
          command.workspaceId,
          command.teamId,
          this.restoreGeneration,
          authorization.resourceRevision
        ),
      }),
      context,
      command.workspaceId,
      command.teamId,
      (value, authority) => {
        const result = parseRevalidationResponse(value, command, context, this.restoreGeneration);
        requireAuthorityRevision(
          authority,
          result.kind === 'valid'
            ? result.authorization.resourceRevision
            : result.kind === 'conflict'
              ? result.currentRevision
              : null
        );
        return result;
      }
    );
  }

  execute(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandGatewayExecutionResult> {
    return this.request(
      'execute',
      Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        operation: 'execute',
        command,
        authorization,
        context: serializeContext(context),
        authority: serializeAuthority(
          context,
          command.workspaceId,
          command.teamId,
          this.restoreGeneration,
          authorization.resourceRevision
        ),
      }),
      context,
      command.workspaceId,
      command.teamId,
      (value, authority) => {
        const result = parseExecutionResponse(value, command, context, this.restoreGeneration);
        if (result.kind !== 'result') {
          requireAuthorityRevision(authority, null);
          return result;
        }
        requireAuthorityRevision(authority, result.authorization.resourceRevision);
        if (
          result.result.kind === 'conflict' &&
          result.result.currentRevision !== result.authorization.resourceRevision
        ) {
          throw new TypeError('orchestrator-lifecycle-execution-conflict-revision-invalid');
        }
        return result;
      }
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
  }

  private request<Value>(
    operation: LifecycleOperation,
    message: Readonly<Record<string, unknown>>,
    context: QueryContext,
    workspaceId: WorkspaceId,
    teamId: TeamId,
    parse: (value: unknown, authority: LifecycleResponseAuthority) => Value
  ): Promise<Value> {
    const signal = context.signal;
    if (this.closed || signal.aborted) {
      return Promise.reject(new Error('orchestrator-lifecycle-client-unavailable'));
    }
    let exchangeId: string;
    try {
      exchangeId = this.generateExchangeId();
      if (!EXCHANGE_ID_PATTERN.test(exchangeId)) throw new TypeError();
    } catch {
      return Promise.reject(new Error('orchestrator-lifecycle-request-identity-invalid'));
    }
    const body = `${JSON.stringify({ ...message, exchangeId })}\n`;
    if (Buffer.byteLength(body) > MAXIMUM_MESSAGE_BYTES) {
      return Promise.reject(new Error('orchestrator-lifecycle-request-too-large'));
    }

    return new Promise<Value>((resolve, reject) => {
      const socket = this.connect({ path: this.socketPath });
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
      if (signal.aborted) {
        abort();
        return;
      }
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
          const envelope: unknown = JSON.parse(response.slice(0, newline));
          if (
            !isRecord(envelope) ||
            !hasExactKeys(envelope, [
              'schemaVersion',
              'exchangeId',
              'operation',
              'authority',
              'payload',
            ]) ||
            envelope.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION ||
            envelope.exchangeId !== exchangeId ||
            envelope.operation !== operation
          ) {
            throw new TypeError();
          }
          const authority = parseResponseAuthority(
            envelope.authority,
            context,
            workspaceId,
            teamId,
            this.restoreGeneration
          );
          finish(null, parse(envelope.payload, authority));
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
