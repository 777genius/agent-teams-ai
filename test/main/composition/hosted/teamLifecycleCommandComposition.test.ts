import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  type HostedAuthenticatedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  createOrchestratorLifecycleOwnerProof,
  parseOrchestratorLifecycleOwnerProofKey,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import { HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS } from '@features/team-lifecycle/main/hosted';
import {
  createHostedApplication,
  HOSTED_READINESS_DIMENSIONS,
} from '@main/composition/hosted/application';
import { readHostedLifecycleOrchestratorTrustAnchor } from '@main/standalone';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  createOptionalTeamLifecycleCommandComposition,
  createTeamLifecycleCommandComposition,
} from '../../../../src/main/composition/hosted/teamLifecycleCommandComposition';

import type { Socket } from 'node:net';

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
const SOCKET_IDENTITY = Object.freeze({
  device: '253',
  inode: '9002',
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  mode: 0o600,
});
const OWNER_BINDING = Object.freeze({
  ownerAuthority: 'owner-authority_lifecycle-command-composition',
  ownerGeneration: 7,
  ownerSessionId: 'owner-session_lifecycle-command-composition-0001',
  socketIdentity: SOCKET_IDENTITY,
});
const OWNER_PROOF_KEY = parseOrchestratorLifecycleOwnerProofKey('ef'.repeat(32));
const BOOTSTRAP_BINDING = Object.freeze({
  deploymentId: DEPLOYMENT_ID,
  bootId: BOOT_ID,
  workspaceId: WORKSPACE_ID,
  mountGeneration: 3,
  bootstrapDigest: '12'.repeat(32),
  ownerArtifactDigest: `sha256:${'34'.repeat(32)}`,
  proofKeyId: 'b9c61610704cb9b9ea441aa8afe5d7d8e852a30f918001cda5c19951ffb62aad',
});
const OWNER_EFFECT_FENCE = Object.freeze({
  grantRevision: 'cd'.repeat(32),
  identityChecksum: 'ab'.repeat(32),
});

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
    captureTeamWorkspaceGrantFence: async () =>
      Object.freeze({
        ownerEffectFence: OWNER_EFFECT_FENCE,
        revalidate: async () => true,
      }),
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

function authorization(request: Record<string, unknown>) {
  const payload = request.payload as Record<string, unknown>;
  const context = payload.context as Record<string, unknown>;
  const command = payload.command as Record<string, unknown>;
  return {
    grantId: 'grant_lifecycle-command-composition-0001',
    authorizationGeneration: 'authorization-generation_lifecycle-command-composition-0001',
    deploymentId: context.deploymentId,
    bootId: BOOT_ID,
    resourceRevision: REVISION,
    actorId: context.actorId,
    workspaceId: command.workspaceId,
    teamId: command.teamId,
    restoreGeneration: 7,
    mountGeneration: 3,
    ownerEffectFence: request.ownerEffectFence,
  };
}

function responseEnvelope(
  request: Record<string, unknown>,
  payload: unknown,
  resourceRevision?: unknown
) {
  const requestProvenance = request.provenance as {
    readonly from: unknown;
    readonly to: unknown;
    readonly target: unknown;
  };
  const envelope = {
    schemaVersion: 2,
    exchangeId: request.exchangeId,
    operation: request.operation,
    provenance: {
      from: requestProvenance.to,
      to: requestProvenance.from,
      target: requestProvenance.target,
    },
    ownerBinding: OWNER_BINDING,
    ownerEffectFence: request.ownerEffectFence,
    authority:
      resourceRevision === undefined
        ? (request.payload as Record<string, unknown>).authority
        : {
            ...((request.payload as Record<string, unknown>).authority as Record<string, unknown>),
            resourceRevision,
          },
    payload,
  };
  return {
    ...envelope,
    ownerProof: createOrchestratorLifecycleOwnerProof(OWNER_PROOF_KEY, 'response', envelope),
  };
}

async function centralApplication() {
  const application = createHostedApplication({
    components: [],
    readinessProbes: HOSTED_READINESS_DIMENSIONS.map((dimension) =>
      Object.freeze({
        id: `lifecycle-command-composition-${dimension}`,
        dimension,
        readiness: async () => ({ ready: true, reasons: [] }),
      })
    ),
    routeContributions: [
      Object.freeze({
        id: 'team-lifecycle.hosted-command.test.v1',
        facade: Object.freeze({}),
        routes: HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
      }),
    ],
  });
  await application.start();
  return application;
}

async function createAclServer() {
  const requests: Record<string, unknown>[] = [];
  let ready = true;
  let onOwnerLoss: (() => void) | undefined;

  class FakeSocket extends EventEmitter {
    destroyed = false;
    private requestHalfClosed = false;

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
      if (!this.requestHalfClosed) {
        this.requestHalfClosed = true;
        if (chunk !== undefined) this.write(chunk);
        return this;
      }
      if (chunk !== undefined && !this.destroyed) this.emit('data', chunk);
      if (!this.destroyed) {
        this.emit('end');
        this.destroy();
      }
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
    socketPath: '/tmp/hosted-lifecycle-command-composition.sock',
    requests,
    connect: () => new FakeSocket() as unknown as Socket,
    inspectSocketIdentity: async () => SOCKET_IDENTITY,
    connectReadiness: async (options: { readonly onOwnerLoss: () => void }) => {
      onOwnerLoss = options.onOwnerLoss;
      requests.push({ operation: 'readiness' });
      return {
        isReady: () => ready,
        currentBinding: () => (ready ? OWNER_BINDING : null),
        invalidate: () => {
          ready = false;
          onOwnerLoss?.();
        },
        close: () => {
          ready = false;
        },
      };
    },
    loseOwner: () => {
      ready = false;
      onOwnerLoss?.();
    },
    close: async () => undefined,
  });
}

function respond(request: Record<string, unknown>, socket: Socket): void {
  try {
    const operation = request.operation;
    const payload = request.payload as Record<string, unknown>;
    if (operation === 'authorize') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, {
            schemaVersion: 2,
            kind: 'authorized',
            authorization: authorization(request),
          })
        )}\n`
      );
      return;
    }
    if (operation === 'revalidate') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, {
            schemaVersion: 2,
            kind: 'valid',
            authorization: authorization(request),
          })
        )}\n`
      );
      return;
    }
    if (operation === 'control_state') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 1,
              kind: 'control_state',
              workspaceId: WORKSPACE_ID,
              teamId: TEAM_ID,
              deploymentId: DEPLOYMENT_ID,
              bootId: BOOT_ID,
              runId: RUN_ID,
              resourceRevision: REVISION,
              availableActions: ['stop', 'recover'],
            },
            REVISION
          )
        )}\n`
      );
      return;
    }
    if (operation === 'release') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(
            request,
            {
              schemaVersion: 2,
              kind: 'released',
              authorization: payload.authorization,
            },
            REVISION
          )
        )}\n`
      );
      return;
    }
    if (operation === 'replay_lookup') {
      socket.end(
        `${JSON.stringify(
          responseEnvelope(request, {
            schemaVersion: 2,
            kind: 'not_started',
            durableCommand: payload.durableCommand,
          })
        )}\n`
      );
      return;
    }
    socket.end(
      `${JSON.stringify(
        responseEnvelope(request, {
          schemaVersion: 2,
          kind: 'settled',
          durableCommand: payload.durableCommand,
          authorization: authorization(request),
          result: {
            schemaVersion: 1,
            kind: 'accepted',
            action: (payload.command as Record<string, unknown>).action,
            commandId: COMMAND_ID,
            workspaceId: WORKSPACE_ID,
            teamId: TEAM_ID,
            runId: RUN_ID,
            resourceRevision: REVISION,
          },
        })
      )}\n`
    );
  } catch {
    socket.destroy();
  }
}

describe('team lifecycle command hosted composition', () => {
  it('does not require the trust anchor when standalone startup has no lifecycle runtime', () => {
    expect(readHostedLifecycleOrchestratorTrustAnchor(null, {})).toBeNull();
  });

  it('does not compose a lifecycle command route without an admitted runtime instance', async () => {
    await expect(
      createOptionalTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: null,
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: null,
      })
    ).resolves.toBeNull();
  });

  it('stays unmounted until the central HostedApplication route admission is supplied', async () => {
    await expect(
      createOptionalTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-not-opened.sock',
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: 3,
      })
    ).resolves.toBeNull();

    await expect(
      createTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-not-opened.sock',
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: 3,
      })
    ).rejects.toThrow('hosted-lifecycle-command-authoritative-admission-required');
  });

  it('registers readiness cleanup before awaiting a deferred owner connection', async () => {
    const application = await centralApplication();
    const closeReadiness = vi.fn();
    const readiness = {
      isReady: () => false,
      currentBinding: () => null,
      invalidate: vi.fn(),
      close: closeReadiness,
    };
    let resolveReadiness: ((value: typeof readiness) => void) | undefined;
    const deferredReadiness = new Promise<typeof readiness>((resolve) => {
      resolveReadiness = resolve;
    });
    let registeredCleanup: (() => void) | undefined;
    const order: string[] = [];

    try {
      const pending = createTeamLifecycleCommandComposition({
        authentication: authenticated(),
        runtimeInstance: runtimeInstance(),
        expectedDeploymentId: DEPLOYMENT_ID,
        orchestratorSocketPath: '/tmp/hosted-lifecycle-command-deferred-readiness.sock',
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        orchestratorExpectedOwnerBinding: OWNER_BINDING,
        orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
        connectReadiness: async () => {
          order.push('connect');
          return deferredReadiness;
        },
        registerReadinessCleanup: (cleanup) => {
          order.push(cleanup === null ? 'clear' : 'register');
          if (cleanup !== null && registeredCleanup === undefined) registeredCleanup = cleanup;
        },
        restoreGeneration: 7,
        mountGeneration: 3,
        routeAdmissionBinding: application,
      });

      expect(order).toEqual(['register', 'connect']);
      expect(registeredCleanup).toEqual(expect.any(Function));
      registeredCleanup?.();
      resolveReadiness?.(readiness);

      await expect(pending).rejects.toThrow('hosted-lifecycle-command-composition-unavailable');
      expect(closeReadiness).toHaveBeenCalled();
      expect(order.at(-1)).toBe('clear');
    } finally {
      await application.stop();
    }
  });

  it('mounts one authenticated ACL-only contribution, carries its command scope, and closes cleanly', async () => {
    const acl = await createAclServer();
    const application = await centralApplication();
    const onFatalOwnerLoss = vi.fn();
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
      onFatalOwnerLoss,
      now: () => 1,
    });
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      expect(composition.isReady()).toBe(true);
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
        'replay_lookup',
        'execute',
        'revalidate',
        'release',
      ]);
      expect(acl.requests[1]).toMatchObject({
        schemaVersion: 2,
        ownerBinding: OWNER_BINDING,
        payload: {
          context: {
            deploymentId: DEPLOYMENT_ID,
            bootId: BOOT_ID,
            authorizedScope: 'scope_hosted-lifecycle-command',
          },
        },
      });

      acl.loseOwner();
      expect(composition.isReady()).toBe(false);
      expect(onFatalOwnerLoss).toHaveBeenCalledOnce();
      expect(onFatalOwnerLoss).toHaveBeenCalledWith(
        new Error('hosted-lifecycle-orchestrator-owner-lost')
      );
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
      expect(acl.requests).toHaveLength(7);
    } finally {
      composition.close();
      await app.close();
      await application.stop();
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
        orchestratorTrustAnchor: OWNER_PROOF_KEY,
        restoreGeneration: 7,
        mountGeneration: 3,
      })
    ).rejects.toThrow('hosted-lifecycle-command-deployment-binding-invalid');

    const acl = await createAclServer();
    const application = await centralApplication();
    const composition = await createTeamLifecycleCommandComposition({
      authentication: authenticated(['hosted.query']),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      orchestratorSocketPath: acl.socketPath,
      orchestratorTrustAnchor: OWNER_PROOF_KEY,
      orchestratorExpectedOwnerBinding: OWNER_BINDING,
      orchestratorBootstrapBinding: BOOTSTRAP_BINDING,
      orchestratorConnect: acl.connect,
      orchestratorInspectSocketIdentity: acl.inspectSocketIdentity,
      connectReadiness: acl.connectReadiness,
      restoreGeneration: 7,
      mountGeneration: 3,
      routeAdmissionBinding: application,
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
      const controlState = await app.inject({
        method: 'POST',
        url: '/api/hosted/v1/team-lifecycle/control-state',
        payload: { schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID },
      });
      expect(response.statusCode).toBe(503);
      expect(controlState.statusCode).toBe(200);
      expect(controlState.json()).toMatchObject({
        kind: 'control_state',
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
      });
      expect(acl.requests.map((request) => request.operation)).toEqual([
        'readiness',
        'control_state',
      ]);
      expect(acl.requests[1]).toMatchObject({
        payload: { context: { authorizedScope: 'scope_hosted-lifecycle-control-state' } },
      });
    } finally {
      composition.close();
      await app.close();
      await application.stop();
      await acl.close();
    }
  });

  it('keeps standalone lifecycle routes conditional and supplies the authoritative route binding', async () => {
    const source = await readFile(resolve('src/main/standalone.ts'), 'utf8');
    const shutdown = source.slice(source.indexOf('async function shutdown'));

    expect(source.match(/createOptionalTeamLifecycleCommandComposition\(\{/g)).toHaveLength(1);
    expect(source).toContain('authentication: hostedAccessFeature.http');
    expect(source).toContain('runtimeInstance: hostedDiagnosticsRuntimeInstance');
    expect(source).toContain('expectedDeploymentId: hostedAccessFeature.deploymentId');
    expect(source).toContain('hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET');
    expect(source).toContain(
      'hostedBootstrapEnvironment.HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT'
    );
    expect(source).toContain('await createOptionalTeamLifecycleCommandComposition({');
    const compositionCall = source.slice(
      source.indexOf('await createOptionalTeamLifecycleCommandComposition({'),
      source.indexOf('const hostedTeamTaskBoardRoutes')
    );
    const optionalRuntimeGate = source.slice(
      source.lastIndexOf(
        'hostedLifecycleCommands =',
        source.indexOf('await createOptionalTeamLifecycleCommandComposition({')
      ),
      source.indexOf('await createOptionalTeamLifecycleCommandComposition({')
    );
    expect(optionalRuntimeGate).toContain('hostedDiagnosticsRuntimeInstance === null');
    expect(optionalRuntimeGate).toContain('? null');
    expect(optionalRuntimeGate).not.toContain('readHostedLifecycleOrchestratorTrustAnchor');
    expect(source).toContain('readHostedLifecycleOrchestratorTrustAnchor(');
    expect(source).toContain('hostedBootstrapEnvironment');
    expect(compositionCall).toContain('routeAdmissionBinding: hostedRouteAdmissionBinding');
    expect(compositionCall).toContain('restoreGeneration: hostedAccessFeature.restoreGeneration');
    expect(compositionCall).toContain('orchestratorTrustAnchor: lifecycleTrustAnchor');
    expect(source).toContain('hostedLifecycleCommandRoutes: hostedLifecycleCommands');
    expect(shutdown.indexOf('hostedLifecycleCommands?.close()')).toBeLessThan(
      shutdown.indexOf('httpServer.stop()')
    );
  });
});
