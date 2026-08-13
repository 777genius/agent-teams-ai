import {
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
  type HostedCoordinationEventBootstrapSnapshot,
} from '../../../../contracts';

import type { CoordinationEventHandoff } from '../../../../core/application';
import type { TeamId } from '@shared/contracts/hosted';

interface HostedCoordinationBootstrapSocket {
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

interface HostedCoordinationBootstrapRawRequest {
  readonly aborted: boolean;
  readonly destroyed: boolean;
  readonly socket: HostedCoordinationBootstrapSocket;
  once(event: 'aborted', listener: () => void): unknown;
  removeListener(event: 'aborted', listener: () => void): unknown;
}

interface HostedCoordinationBootstrapRawReply {
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

interface HostedCoordinationBootstrapRequest {
  readonly body: unknown;
  readonly raw: HostedCoordinationBootstrapRawRequest;
}

interface HostedCoordinationBootstrapReply {
  readonly raw: HostedCoordinationBootstrapRawReply;
  code(statusCode: number): HostedCoordinationBootstrapReply;
  header(name: string, value: string): HostedCoordinationBootstrapReply;
  send(payload: unknown): unknown;
}

interface HostedCoordinationBootstrapApplication {
  post(
    route: string,
    handler: (
      request: HostedCoordinationBootstrapRequest,
      reply: HostedCoordinationBootstrapReply
    ) => Promise<unknown>
  ): void;
}

export interface HostedCoordinationEventBootstrapFence {
  readonly sourceGeneration: string;
  isCurrent(): boolean | Promise<boolean>;
}

export interface HostedCoordinationEventBootstrapAuthorizer {
  captureTeamBootstrapFence(
    request: unknown,
    teamId: TeamId
  ): Promise<HostedCoordinationEventBootstrapFence | null>;
}

interface HostedCoordinationEventBootstrapControllerOptions {
  readonly handoff: CoordinationEventHandoff;
  readonly authorizer: HostedCoordinationEventBootstrapAuthorizer;
}

class BootstrapAuthorizationError extends Error {}
class BootstrapOperationAbortedError extends Error {}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function canonicalTeamId(value: unknown): value is TeamId {
  return typeof value === 'string' && /^team_[0-9a-f]{32}$/u.test(value);
}

function parseRequest(value: unknown): TeamId | null {
  const input = record(value);
  if (input === null) return null;
  const keys = Object.keys(input);
  return keys.length === 2 &&
    keys.includes('schemaVersion') &&
    keys.includes('teamId') &&
    input.schemaVersion === HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION &&
    canonicalTeamId(input.teamId)
    ? input.teamId
    : null;
}

function validSourceGeneration(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}

function waitForCurrent(
  fence: HostedCoordinationEventBootstrapFence,
  signals: readonly AbortSignal[]
): Promise<boolean> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (current: boolean): void => {
      if (settled) return;
      settled = true;
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
      resolve(current);
    };
    const onAbort = (): void => finish(false);
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => fence.isCurrent())
      .then(
        (current) => finish(current === true),
        () => finish(false)
      );
    if (signals.some((signal) => signal.aborted)) onAbort();
  });
}

function waitForOperationUnlessAborted<T>(
  operation: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(new BootstrapOperationAbortedError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (next: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      next();
    };
    const onAbort = (): void => finish(() => reject(new BootstrapOperationAbortedError()));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      );
    if (signal.aborted) onAbort();
  });
}

function sendError(
  reply: HostedCoordinationBootstrapReply,
  statusCode: 400 | 403 | 503,
  error: string
): unknown {
  return reply.code(statusCode).send(Object.freeze({ error }));
}

export class HostedCoordinationEventBootstrapController {
  private readonly options: HostedCoordinationEventBootstrapControllerOptions;
  private readonly activeOperations = new Set<AbortController>();
  private closed = false;

  constructor(options: HostedCoordinationEventBootstrapControllerOptions) {
    if (!options?.handoff || !options.authorizer) {
      throw new Error('invalid_hosted_coordination_event_bootstrap_options');
    }
    this.options = options;
  }

  register(app: unknown): void {
    const httpApp = app as HostedCoordinationBootstrapApplication;
    httpApp.post(HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE, (request, reply) =>
      this.handle(request, reply)
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const operation of [...this.activeOperations]) operation.abort();
    this.activeOperations.clear();
  }

  private async handle(
    request: HostedCoordinationBootstrapRequest,
    reply: HostedCoordinationBootstrapReply
  ): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    if (this.closed) {
      return sendError(reply, 503, 'coordination_event_bootstrap_unavailable');
    }
    const teamId = parseRequest(request.body);
    if (teamId === null) {
      return sendError(reply, 400, 'coordination_event_bootstrap_request_invalid');
    }

    const ownerController = new AbortController();
    const abort = (): void => ownerController.abort();
    request.raw.once('aborted', abort);
    request.raw.socket.once('close', abort);
    reply.raw.once('close', abort);
    if (
      request.raw.aborted ||
      request.raw.destroyed ||
      request.raw.socket.destroyed ||
      reply.raw.destroyed
    ) {
      abort();
    }
    this.activeOperations.add(ownerController);
    if (ownerController.signal.aborted) {
      this.activeOperations.delete(ownerController);
      request.raw.removeListener('aborted', abort);
      request.raw.socket.removeListener('close', abort);
      reply.raw.removeListener('close', abort);
      return undefined;
    }

    let fence: HostedCoordinationEventBootstrapFence | null;
    try {
      fence = await waitForOperationUnlessAborted(
        () => this.options.authorizer.captureTeamBootstrapFence(request, teamId),
        ownerController.signal
      );
      if (fence === null || !validSourceGeneration(fence.sourceGeneration)) {
        throw new BootstrapAuthorizationError();
      }
      const capturedFence = fence;
      const snapshot = await waitForOperationUnlessAborted(
        () =>
          this.options.handoff.captureExternalSnapshot({
            request: { scopeKind: 'team', scopeId: teamId },
            source: {
              readStableSnapshot: async (_scope, context) => {
                if (ownerController.signal.aborted || context.signal.aborted) {
                  throw new BootstrapOperationAbortedError();
                }
                if (
                  !(await waitForCurrent(capturedFence, [ownerController.signal, context.signal]))
                ) {
                  throw new BootstrapAuthorizationError();
                }
                const bootstrap: HostedCoordinationEventBootstrapSnapshot = Object.freeze({
                  schemaVersion: HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
                  kind: 'team_event_bootstrap',
                  teamId,
                });
                return Object.freeze({
                  snapshot: bootstrap,
                  revisionVector: Object.freeze([]),
                  sourceGenerationBefore: capturedFence.sourceGeneration,
                  sourceGenerationAfter: capturedFence.sourceGeneration,
                });
              },
            },
          }),
        ownerController.signal
      );
      if (
        ownerController.signal.aborted ||
        !(await waitForCurrent(capturedFence, [ownerController.signal]))
      ) {
        throw new BootstrapAuthorizationError();
      }
      return reply.code(200).send(snapshot);
    } catch (error) {
      if (ownerController.signal.aborted) return undefined;
      return error instanceof BootstrapAuthorizationError
        ? sendError(reply, 403, 'coordination_event_bootstrap_forbidden')
        : sendError(reply, 503, 'coordination_event_bootstrap_unavailable');
    } finally {
      this.activeOperations.delete(ownerController);
      request.raw.removeListener('aborted', abort);
      request.raw.socket.removeListener('close', abort);
      reply.raw.removeListener('close', abort);
      ownerController.abort();
    }
  }
}
