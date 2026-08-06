import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  type HostedAuthenticatedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { registerHttpRoutes } from '@main/http';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  createOptionalTeamLifecycleCommandComposition,
  createTeamLifecycleCommandComposition,
} from '../../../../src/main/composition/hosted/teamLifecycleCommandComposition';

import type { Server, Socket } from 'node:net';

const DEPLOYMENT_ID = 'deployment_lifecycle-command-composition';
const BOOT_ID = 'boot_lifecycle-command-composition';
const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const RUN_ID = `run_${'c'.repeat(32)}`;
const COMMAND_ID = 'lifecycle-command_composition-0001';
const IDEMPOTENCY_KEY = 'idempotency_composition-0001';
const REVISION = 'revision_composition';
const USER_ID = parseUserId('user_lifecycle-command-composition');
const SESSION_ID = parseHostedSessionId('session_lifecycle-command-composition');

function runtimeInstance() {
  return createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
    appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
    workspaceRoots: [],
    tempRoot: { kind: 'temp', reference: 'isolated:temp' },
    logsRoot: { kind: 'logs', reference: 'isolated:logs' },
  });
}

function authenticated(permissions: readonly string[] = ['hosted.query', 'hosted.command']) {
  return Object.freeze({
    authenticatedPrincipalFor: () =>
      Object.freeze({
        principal: Object.freeze({
          userId: USER_ID,
          displayName: 'Lifecycle command member',
          role: 'member',
          permissions: Object.freeze([...permissions]),
          authenticationMethod: 'oidc',
          sessionId: SESSION_ID,
        }),
        authenticatedSessionId: SESSION_ID,
      }) as HostedAuthenticatedPrincipal,
  });
}

function launchBody() {
  return {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: REVISION,
  };
}

function authorization() {
  return {
    grantId: 'grant_lifecycle-command-composition-0001',
    authorizationGeneration: 'authorization-generation_lifecycle-command-composition-0001',
    bootId: BOOT_ID,
    resourceRevision: REVISION,
  };
}

async function createAclServer() {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-command-composition-'));
  const socketPath = join(directory, 'orchestrator.sock');
  const requests: Record<string, unknown>[] = [];
  let readinessSocket: Socket | null = null;
  const server = createServer((socket) =>
    receive(socket, requests, () => {
      readinessSocket = socket;
    })
  );
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  return Object.freeze({
    socketPath,
    requests,
    loseOwner: () => readinessSocket?.destroy(),
    close: async () => {
      await closeServer(server);
      await rm(directory, { force: true, recursive: true });
    },
  });
}

function receive(
  socket: Socket,
  requests: Record<string, unknown>[],
  captureReadiness: () => void
): void {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    try {
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      const operation = request.operation;
      if (operation === 'readiness') {
        captureReadiness();
        socket.write(
          `${JSON.stringify({
            schemaVersion: 1,
            kind: 'ready',
            owner: 'external-orchestrator',
            capability: 'hosted-lifecycle-command',
          })}\n`
        );
        return;
      }
      if (operation === 'authorize') {
        socket.end(
          `${JSON.stringify({ schemaVersion: 1, kind: 'authorized', authorization: authorization() })}\n`
        );
        return;
      }
      if (operation === 'revalidate') {
        socket.end(
          `${JSON.stringify({ schemaVersion: 1, kind: 'valid', authorization: authorization() })}\n`
        );
        return;
      }
      socket.end(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'result',
          authorization: authorization(),
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
    } catch {
      socket.destroy();
    }
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

describe('team lifecycle command hosted composition', () => {
  it('does not compose a lifecycle command route without an admitted runtime instance', async () => {
    await expect(
      createOptionalTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: null,
        expectedDeploymentId: DEPLOYMENT_ID,
      })
    ).resolves.toBeNull();
  });

  it('mounts one authenticated ACL-only contribution, carries its command scope, and closes cleanly', async () => {
    const acl = await createAclServer();
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      now: () => 1,
    });
    const app = Fastify();
    registerHttpRoutes(
      app,
      {
        projectScanner: {},
        sessionParser: {},
        subagentResolver: {},
        chunkBuilder: {},
        dataCache: {},
        updaterService: {},
        sshConnectionManager: {},
        hostedAuth: {
          register: () => undefined,
        },
        hostedLifecycleCommandRoutes: composition,
      } as never,
      () => Promise.resolve()
    );
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ kind: 'accepted', action: 'launch' });
      expect(acl.requests.map((request) => request.operation)).toEqual([
        'readiness',
        'authorize',
        'revalidate',
        'execute',
        'revalidate',
      ]);
      expect(acl.requests[1]).toMatchObject({
        context: {
          deploymentId: DEPLOYMENT_ID,
          bootId: BOOT_ID,
          authorizedScope: 'scope_hosted-lifecycle-command',
        },
      });

      acl.loseOwner();
      await vi.waitFor(async () => {
        const unavailable = await app.inject({
          method: 'POST',
          url: '/api/hosted/v1/team-lifecycle/launch',
          payload: launchBody(),
        });
        expect(unavailable.statusCode).toBe(503);
      });
      composition.close();
      const closed = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      expect(closed.statusCode).toBe(503);
      expect(acl.requests).toHaveLength(5);
    } finally {
      composition.close();
      await app.close();
      await acl.close();
    }
  });

  it('rejects deployment mismatch and lacks a command route when the authenticated role lacks permission', async () => {
    await expect(
      createTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: 'deployment_lifecycle-command-other',
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-invalid.sock',
      })
    ).rejects.toThrow('hosted-lifecycle-command-deployment-binding-invalid');

    const acl = await createAclServer();
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(['hosted.query']),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      now: () => 1,
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/launch',
        payload: launchBody(),
      });
      expect(response.statusCode).toBe(503);
      expect(acl.requests.map((request) => request.operation)).toEqual(['readiness']);
    } finally {
      composition.close();
      await app.close();
      await acl.close();
    }
  });

  it('mounts the standalone contribution once and closes it before the HTTP server', async () => {
    const source = await readFile(resolve('src/main/standalone.ts'), 'utf8');
    const shutdown = source.slice(source.indexOf('async function shutdown'));

    expect(source.match(/createOptionalTeamLifecycleCommandComposition\(\{/g)).toHaveLength(1);
    expect(source).toContain('authentication: hostedAccessFeature.http');
    expect(source).toContain('runtimeInstance: hostedDiagnosticsRuntimeInstance');
    expect(source).toContain('expectedDeploymentId: hostedAccessFeature.deploymentId');
    expect(source).toContain(
      'orchestratorSocketPath: process.env.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET'
    );
    expect(source).toContain('await createOptionalTeamLifecycleCommandComposition({');
    expect(source).toContain('hostedLifecycleCommandRoutes: hostedLifecycleCommands');
    expect(shutdown.indexOf('hostedLifecycleCommands?.close()')).toBeLessThan(
      shutdown.indexOf('httpServer.stop()')
    );
  });
});
