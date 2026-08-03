import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type HostedLifecycleCommand,
  OrchestratorLifecycleCommandClient,
  parseHostedLifecycleCommand,
} from '@features/team-lifecycle/main/hosted';
import { createQueryContext, parseRevision } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type { Server, Socket } from 'node:net';

const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const RUN_ID = `run_${'c'.repeat(32)}`;
const COMMAND_ID = 'lifecycle-command_socket-0001';
const IDEMPOTENCY_KEY = 'idempotency_socket-0001';
const REVISION = parseRevision('revision_socket');

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
    bootId: 'boot_lifecycle-command-socket',
    resourceRevision,
  };
}

async function createFakeUnixSocket(
  respond: (request: Record<string, unknown>, socket: Socket) => void
) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-command-socket-'));
  const socketPath = join(directory, 'orchestrator.sock');
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        respond(request, socket);
      } catch {
        socket.destroy();
      }
    });
  });
  await listen(server, socketPath);

  return Object.freeze({
    socketPath,
    requests,
    close: async () => {
      await closeServer(server);
      await rm(directory, { force: true, recursive: true });
    },
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      server.removeListener('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.removeListener('error', fail);
      resolve();
    };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe('OrchestratorLifecycleCommandClient', () => {
  it('uses a bounded fake Unix socket protocol and serializes no browser secret or AbortSignal', async () => {
    const target = command();
    const fake = await createFakeUnixSocket((request, socket) => {
      const operation = request.operation;
      if (operation === 'authorize') {
        socket.end(
          `${JSON.stringify({ schemaVersion: 1, kind: 'authorized', authorization: authorizationWire() })}\n`
        );
        return;
      }
      if (operation === 'revalidate') {
        socket.end(
          `${JSON.stringify({ schemaVersion: 1, kind: 'valid', authorization: authorizationWire() })}\n`
        );
        return;
      }
      socket.end(
        `${JSON.stringify({
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
        })}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({ socketPath: fake.socketPath });
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
        command: target,
        context: {
          actorId: requestContext.actorId,
          sessionId: requestContext.sessionId,
          deploymentId: requestContext.deploymentId,
          bootId: requestContext.bootId,
          requestId: requestContext.requestId,
          authorizedScope: requestContext.authorizedScope,
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

  it('rejects an invalid ACL response instead of accepting an unclassified result', async () => {
    const fake = await createFakeUnixSocket((_request, socket) => {
      socket.end(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'authorized',
          authorization: { ...authorizationWire(), privateValue: 'not-allowed' },
        })}\n`
      );
    });
    const client = new OrchestratorLifecycleCommandClient({ socketPath: fake.socketPath });
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
    const client = new OrchestratorLifecycleCommandClient({ socketPath: fake.socketPath });
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
