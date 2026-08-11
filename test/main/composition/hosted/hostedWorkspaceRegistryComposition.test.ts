// @vitest-environment node

import { readFile } from 'node:fs/promises';

import {
  type HostedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  HOSTED_WORKSPACE_REGISTRY_ROUTES,
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
} from '@features/workspace-registry/contracts';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '@features/workspace-registry/core';
import {
  classifyHostedWorkspaceRegistryAuthorization,
  createHostedWorkspaceRegistryComposition,
} from '@main/composition/hosted/hostedWorkspaceRegistryComposition';
import { parseBootId, parseWorkspaceId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';
import type { HostedWorkspaceRegistryAuthenticationPort } from '@main/composition/hosted/hostedWorkspaceRegistryComposition';
import type { FastifyInstance } from 'fastify';

const RUNTIME_WORKSPACE_ID = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const STALE_RUNTIME_WORKSPACE_ID = parseWorkspaceId(`workspace_${'0'.repeat(32)}`);
const PUBLIC_WORKSPACE_ID = parseWorkspaceId(`workspace_${'f'.repeat(32)}`);
const BOOT_ID = parseBootId('boot_workspace-registry-composition');
const STALE_BOOT_ID = parseBootId('boot_workspace-registry-stale');
const SESSION_ID = parseHostedSessionId('session-oidc_workspace-registry');
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function runtimeInstance() {
  return createRuntimeInstanceContext({
    deploymentId: 'deployment_workspace-registry-composition',
    bootId: BOOT_ID,
    claudeRoot: { kind: 'claude', reference: '/runtime/claude' },
    appDataRoot: { kind: 'app-data', reference: '/runtime/app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: '/runtime/workspace' }],
    tempRoot: { kind: 'temp', reference: '/runtime/temp' },
    logsRoot: { kind: 'logs', reference: '/runtime/logs' },
  });
}

function snapshot(): WorkspaceRegistryStartupSnapshot {
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-runtime-a',
    workspaceId: RUNTIME_WORKSPACE_ID,
    displayName: '/private/runtime/path',
    registrationRevision: 3,
    declaredRootHash: 'a'.repeat(64),
    enabled: true,
  });
  return Object.freeze({
    registry: new WorkspaceRegistrationRegistry([registration]),
    bindings: Object.freeze([
      new WorkspaceMountBinding({
        registration,
        bootId: BOOT_ID,
        mountGeneration: 1,
        declaredRootHash: 'a'.repeat(64),
        observedAt: 100,
        health: 'healthy',
        allowedOperations: ['workspace.registry.get-worktree-git-status'],
      }),
    ]),
  });
}

function mixedBootSnapshot(): WorkspaceRegistryStartupSnapshot {
  const admitted = snapshot();
  const staleRegistration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-runtime-stale',
    workspaceId: STALE_RUNTIME_WORKSPACE_ID,
    displayName: '/private/stale/path',
    registrationRevision: 4,
    declaredRootHash: '0'.repeat(64),
    enabled: true,
  });
  return Object.freeze({
    registry: new WorkspaceRegistrationRegistry([staleRegistration, ...admitted.registry.values()]),
    bindings: Object.freeze([
      new WorkspaceMountBinding({
        registration: staleRegistration,
        bootId: STALE_BOOT_ID,
        mountGeneration: 1,
        declaredRootHash: '0'.repeat(64),
        observedAt: 200,
        health: 'healthy',
        allowedOperations: ['workspace.registry.get-worktree-git-status'],
      }),
      ...admitted.bindings,
    ]),
  });
}

function authentication(): HostedWorkspaceRegistryAuthenticationPort {
  const principal: HostedPrincipal = Object.freeze({
    userId: parseUserId('user_workspace-registry-owner'),
    displayName: 'Owner',
    role: 'owner',
    permissions: ['hosted.query'] as const,
    authenticationMethod: 'oidc',
    sessionId: SESSION_ID,
  });
  return {
    authenticatedPrincipalFor: vi.fn(() =>
      Object.freeze({ principal, authenticatedSessionId: SESSION_ID })
    ),
    projectGrantedPublicWorkspaceId: vi.fn(async (_request, runtimeWorkspaceId) =>
      runtimeWorkspaceId === RUNTIME_WORKSPACE_ID ? PUBLIC_WORKSPACE_ID : null
    ),
    resolveGrantedRuntimeWorkspaceId: vi.fn(async (_request, publicWorkspaceId) =>
      publicWorkspaceId === PUBLIC_WORKSPACE_ID ? RUNTIME_WORKSPACE_ID : null
    ),
  };
}

async function appWith(
  authenticationPort: HostedWorkspaceRegistryAuthenticationPort,
  registrySnapshot: WorkspaceRegistryStartupSnapshot = snapshot()
) {
  const app = Fastify();
  apps.push(app);
  createHostedWorkspaceRegistryComposition({
    authentication: authenticationPort,
    snapshot: registrySnapshot,
    runtimeInstance: runtimeInstance(),
    expectedDeploymentId: 'deployment_workspace-registry-composition',
  }).register(app);
  await app.ready();
  return app;
}

describe('hosted workspace registry composition', () => {
  it('preserves the admitted snapshot through standalone and HttpServices wiring', async () => {
    const [bootstrapSource, standaloneSource, httpSource] = await Promise.all([
      readFile('src/main/composition/hosted/teamLifecycleReadBootstrapSource.ts', 'utf8'),
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/http/index.ts', 'utf8'),
    ]);

    expect(bootstrapSource).toContain('workspaceRegistrySnapshot: snapshot');
    expect(standaloneSource).toContain(
      'workspaceRegistrySnapshot = bootstrap.workspaceRegistrySnapshot'
    );
    expect(standaloneSource).toContain('createHostedWorkspaceRegistryComposition({');
    expect(standaloneSource).toContain('hostedWorkspaceRegistryRoutes,');
    expect(httpSource).toContain('hostedWorkspaceRegistryRoutes?.register(app)');
  });

  it('classifies only exact registry POST routes as CSRF-protected hosted queries', () => {
    for (const path of Object.values(HOSTED_WORKSPACE_REGISTRY_ROUTES)) {
      expect(classifyHostedWorkspaceRegistryAuthorization('POST', path)).toEqual({
        kind: 'authenticated',
        permission: 'hosted.query',
        csrfRequired: true,
        workspaceRequired: false,
      });
      expect(classifyHostedWorkspaceRegistryAuthorization('GET', path)).toEqual({
        kind: 'forbidden',
      });
    }
  });

  it('round-trips only the live principal public ID over the admitted runtime snapshot', async () => {
    const authorization = authentication();
    const app = await appWith(authorization);
    const list = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      payload: { schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION },
    });
    const selection = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
      payload: {
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        workspaceId: PUBLIC_WORKSPACE_ID,
      },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().workspaces[0].workspaceId).toBe(PUBLIC_WORKSPACE_ID);
    expect(list.body).not.toContain(RUNTIME_WORKSPACE_ID);
    expect(selection.statusCode).toBe(200);
    expect(selection.json().workspace.workspaceId).toBe(PUBLIC_WORKSPACE_ID);
    // List and select both revalidate the exact public/runtime mapping at their final return
    // boundary, so the live grant is observed before projection and again after every await.
    expect(authorization.projectGrantedPublicWorkspaceId).toHaveBeenCalledTimes(3);
    expect(authorization.resolveGrantedRuntimeWorkspaceId).toHaveBeenCalledTimes(3);
  });

  it('filters mixed-boot bindings before grant checks and selection labeling', async () => {
    const authorization = authentication();
    const app = await appWith(authorization, mixedBootSnapshot());
    const list = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      payload: { schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION },
    });
    const selection = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
      payload: {
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        workspaceId: PUBLIC_WORKSPACE_ID,
      },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().workspaces).toEqual([
      expect.objectContaining({ workspaceId: PUBLIC_WORKSPACE_ID, label: 'Workspace 1' }),
    ]);
    expect(selection.statusCode).toBe(200);
    expect(selection.json().workspace).toEqual(
      expect.objectContaining({ workspaceId: PUBLIC_WORKSPACE_ID, label: 'Workspace 1' })
    );
    expect(authorization.projectGrantedPublicWorkspaceId).not.toHaveBeenCalledWith(
      expect.anything(),
      STALE_RUNTIME_WORKSPACE_ID
    );
  });

  it('hides denied selection and reports live grant storage failure as unavailable', async () => {
    const deniedAuthorization = Object.freeze({
      ...authentication(),
      resolveGrantedRuntimeWorkspaceId: vi.fn(async () => null),
    });
    const deniedApp = await appWith(deniedAuthorization);
    const denied = await deniedApp.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
      payload: { schemaVersion: 1, workspaceId: PUBLIC_WORKSPACE_ID },
    });
    expect(denied.statusCode).toBe(404);

    const unavailableAuthorization = Object.freeze({
      ...authentication(),
      projectGrantedPublicWorkspaceId: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    });
    const unavailableApp = await appWith(unavailableAuthorization);
    const unavailable = await unavailableApp.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      payload: { schemaVersion: 1 },
    });
    expect(unavailable.statusCode).toBe(503);
  });
});
