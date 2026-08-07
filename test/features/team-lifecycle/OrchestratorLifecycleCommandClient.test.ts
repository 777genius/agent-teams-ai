import { EventEmitter } from 'node:events';

import {
  type HostedLifecycleCommand,
  OrchestratorLifecycleCommandClient,
  parseHostedLifecycleCommand,
} from '@features/team-lifecycle/main/hosted';
import { createQueryContext, parseRevision } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type { Socket } from 'node:net';

const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const RUN_ID = `run_${'c'.repeat(32)}`;
const COMMAND_ID = 'lifecycle-command_socket-0001';
const IDEMPOTENCY_KEY = 'idempotency_socket-0001';
const REVISION = parseRevision('revision_socket');
const EXECUTION_CONFLICT_MISMATCH_REVISION = parseRevision('revision_execution-conflict-mismatch');
const RESTORE_GENERATION = 7;

function command(): HostedLifecycleCommand {
  const parsed = parseHostedLifecycleCommand('launch', {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: REVISION,
  });
  if (!parsed.ok) throw new Error('hosted-lifecycle-socket-command-fixture-invalid');
  return parsed.value;
}

function context() {
  return createQueryContext({
    actorId: 'actor_lifecycle-command-socket',
    sessionId: 'session_lifecycle-command-socket',
    deploymentId: 'deployment_lifecycle-command-socket',
    bootId: 'boot_lifecycle-command-socket',
    requestId: 'request_lifecycle-command-socket',
    authorizedScope: 'scope_lifecycle-command-socket',
    deadlineAtMs: Date.now() + 10_000,
    signal: new AbortController().signal,
  });
}

function authorizationWire(resourceRevision = REVISION) {
  return {
    grantId: 'grant_lifecycle-command-socket-0001',
    authorizationGeneration: 'authorization-generation_lifecycle-command-socket-0001',
    deploymentId: 'deployment_lifecycle-command-socket',
    bootId: 'boot_lifecycle-command-socket',
    resourceRevision,
    actorId: 'actor_lifecycle-command-socket',
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    restoreGeneration: RESTORE_GENERATION,
  };
}

function responseEnvelope(
  request: Record<string, unknown>,
  payload: unknown,
  resourceRevision: unknown,
  authorityOverrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    schemaVersion: 1,
    exchangeId: request.exchangeId,
    operation: request.operation,
    authority: {
      actorId: 'actor_lifecycle-command-socket',
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      deploymentId: 'deployment_lifecycle-command-socket',
      restoreGeneration: RESTORE_GENERATION,
      bootId: 'boot_lifecycle-command-socket',
      resourceRevision,
      ...authorityOverrides,
    },
    payload,
  };
}

async function createFakeUnixSocket(
  respond: (request: Record<string, unknown>, socket: Socket) => void
) {
  const requests: Record<string, unknown>[] = [];
  class FakeSocket extends EventEmitter {
    destroyed = false;

    constructor() {
      super();
      queueMicrotask(() => this.emit('connect'));
    }

    setEncoding(): this {
      return this;
    }

    setTimeout(): this {
      return this;
    }

    write(chunk: string): boolean {
      try {
        const request = JSON.parse(chunk.trim()) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => respond(request, this as unknown as Socket));
      } catch {
        this.destroy();
      }
      return true;
    }

    end(chunk?: string): this {
      if (chunk !== undefined && !this.destroyed) this.emit('data', chunk);
      if (!this.destroyed) this.destroy();
      return this;
    }

    destroy(): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.emit('close');
      return this;
    }
  }

  return Object.freeze({
    socketPath: '/tmp/hosted-lifecycle-command-test.sock',
    connect: () => new FakeSocket() as unknown as Socket,
    requests,
    close: async () => undefined,
  });
}

describe('OrchestratorLifecycleCommandClient', () => {
  it('queries control state and validates response authority on success and negative results', async () => {
    let responseIndex = 0;
    const fake = await createFakeUnixSocket((request, socket) => {
      responseIndex += 1;
      const payload =
        responseIndex === 1
          ? {
              schemaVersion: 1,
              kind: 'control_state',
              workspaceId: WORKSPACE_ID,
              teamId: TEAM_ID,
              deploymentId: 'deployment_lifecycle-command-socket',
              bootId: 'boot_lifecycle-command-socket',
              runId: RUN_ID,
              resourceRevision: REVISION,
              availableActions: ['stop', 'recover'],
            }
          : responseIndex === 2
            ? { schemaVersion: 1, kind: 'not_found' }
            : { schemaVersion: 1, kind: 'unavailable', retryAfterMs: 250 };
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, payload, responseIndex === 1 ? REVISION : null)
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      connect: fake.connect,
    });
    const request = {
      schemaVersion: 1 as const,
      workspaceId: command().workspaceId,
      teamId: command().teamId,
    };
    try {
      await expect(client.getControlState(request, context())).resolves.toMatchObject({
        kind: 'control_state',
        deploymentId: 'deployment_lifecycle-command-socket',
        bootId: 'boot_lifecycle-command-socket',
      });
      await expect(client.getControlState(request, context())).resolves.toEqual({
        schemaVersion: 1,
        kind: 'not_found',
      });
      await expect(client.getControlState(request, context())).resolves.toEqual({
        schemaVersion: 1,
        kind: 'unavailable',
        retryAfterMs: 250,
      });
      expect(fake.requests).toHaveLength(3);
      expect(fake.requests[0]).toMatchObject({
        operation: 'control_state',
        authority: {
          deploymentId: 'deployment_lifecycle-command-socket',
          resourceRevision: null,
        },
      });
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('rejects a deployment-mismatched response authority even for an unavailable result', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            { schemaVersion: 1, kind: 'unavailable', retryAfterMs: null },
            null,
            { deploymentId: 'deployment_lifecycle-command-other' }
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      connect: fake.connect,
    });
    try {
      await expect(client.authorize(command(), context())).rejects.toThrow(
        'orchestrator-lifecycle-response-invalid'
      );
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('accepts a conflict only when response authority echoes deployment and revision', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 1,
              kind: 'conflict',
              reason: 'stale_revision',
              currentRevision: REVISION,
            },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      connect: fake.connect,
    });
    try {
      await expect(client.authorize(command(), context())).resolves.toEqual({
        kind: 'conflict',
        reason: 'stale_revision',
        currentRevision: REVISION,
      });
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('uses a bounded fake Unix socket protocol and serializes no browser secret or AbortSignal', async () => {
    const target = command();
    const fake = await createFakeUnixSocket((request, socket) => {
      const operation = request.operation;
      if (operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 1, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      if (operation === 'revalidate') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 1, kind: 'valid', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 1,
              kind: 'result',
              authorization: authorizationWire(),
              result: {
                schemaVersion: 1,
                kind: 'accepted',
                action: 'launch',
                commandId: COMMAND_ID,
                workspaceId: WORKSPACE_ID,
                teamId: TEAM_ID,
                runId: RUN_ID,
                resourceRevision: REVISION,
              },
            },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      connect: fake.connect,
    });
    const requestContext = context();
    try {
      const authorized = await client.authorize(target, requestContext);
      expect(authorized).toMatchObject({ kind: 'authorized' });
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.revalidate(target, authorized.authorization, requestContext)
      ).resolves.toMatchObject({
        kind: 'valid',
      });
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).resolves.toMatchObject({
        kind: 'result',
        result: { kind: 'accepted' },
      });

      expect(fake.requests.map((request) => request.operation)).toEqual([
        'authorize',
        'revalidate',
        'execute',
      ]);
      expect(fake.requests[0]).toMatchObject({
        schemaVersion: 1,
        exchangeId: expect.stringMatching(/^lifecycle-request_[0-9a-f]{32}$/),
        command: target,
        context: {
          actorId: requestContext.actorId,
          sessionId: requestContext.sessionId,
          deploymentId: requestContext.deploymentId,
          bootId: requestContext.bootId,
          requestId: requestContext.requestId,
          authorizedScope: requestContext.authorizedScope,
        },
        authority: {
          actorId: requestContext.actorId,
          workspaceId: target.workspaceId,
          teamId: target.teamId,
          deploymentId: requestContext.deploymentId,
          restoreGeneration: RESTORE_GENERATION,
          bootId: requestContext.bootId,
          resourceRevision: target.expectedRevision,
        },
      });
      expect(fake.requests[1]).toMatchObject({
        authorization: {
          deploymentId: requestContext.deploymentId,
          restoreGeneration: RESTORE_GENERATION,
        },
      });
      const wire = JSON.stringify(fake.requests);
      expect(wire).not.toContain('signal');
      expect(wire).not.toContain('sessionSecret');
      expect(wire).not.toContain('csrf');
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('rejects an execution conflict whose nested revision mismatches authorization and response authority', async () => {
    const fake = await createFakeUnixSocket((request, socket) => {
      if (request.operation === 'authorize') {
        socket.end(
          `${JSON.stringify(
            responseEnvelope(
              request,
              { schemaVersion: 1, kind: 'authorized', authorization: authorizationWire() },
              REVISION
            )
          )}\n`
        );
        return;
      }
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 1,
              kind: 'result',
              authorization: authorizationWire(),
              result: {
                schemaVersion: 1,
                kind: 'conflict',
                action: 'launch',
                commandId: COMMAND_ID,
                workspaceId: WORKSPACE_ID,
                teamId: TEAM_ID,
                reason: 'stale_revision',
                currentRevision: EXECUTION_CONFLICT_MISMATCH_REVISION,
              },
            },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      connect: fake.connect,
    });
    const target = command();
    const requestContext = context();
    try {
      const authorized = await client.authorize(target, requestContext);
      expect(authorized.kind).toBe('authorized');
      if (authorized.kind !== 'authorized') return;
      await expect(
        client.execute(target, authorized.authorization, requestContext)
      ).rejects.toThrow('orchestrator-lifecycle-response-invalid');
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('rejects an invalid ACL response instead of accepting an unclassified result', async () => {
    const fake = await createFakeUnixSocket((_request, socket) => {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            _request,
            {
              schemaVersion: 1,
              kind: 'authorized',
              authorization: { ...authorizationWire(), privateValue: 'not-allowed' },
            },
            REVISION
          )
        )}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      connect: fake.connect,
    });
    try {
      await expect(client.authorize(command(), context())).rejects.toThrow(
        'orchestrator-lifecycle-response-invalid'
      );
    } finally {
      client.close();
      await fake.close();
    }
  });

  it('destroys an in-flight fake socket request when the composition closes', async () => {
    let releaseConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      releaseConnected = resolve;
    });
    const fake = await createFakeUnixSocket(() => {
      releaseConnected?.();
    });
    const client = new OrchestratorLifecycleCommandClient({
      socketPath: fake.socketPath,
      restoreGeneration: RESTORE_GENERATION,
      connect: fake.connect,
    });
    try {
      const pending = client.authorize(command(), context());
      await connected;
      client.close();
      await expect(pending).rejects.toThrow('orchestrator-lifecycle');
    } finally {
      client.close();
      await fake.close();
    }
  });
});
