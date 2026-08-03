import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type HostedAuthenticatedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_PAGE_ROUTE,
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowResult,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import { createHostedTaskBoardReadComposition } from '@main/composition/hosted/hostedTaskBoardReadComposition';
import { registerHttpRoutes } from '@main/http';
import {
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const NOW_MS = 1_800_000_000_000;
const BOOT_ID = parseBootId(`boot_${'a'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'b'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'d'.repeat(32)}`);
const USER_ID = parseUserId('user_task-board-read-0001');
const SESSION_ID = parseHostedSessionId('session_task-board-read-0001');
const TASK_ID = parseHostedTaskId(`task_${'e'.repeat(32)}`);
const SOURCE_GENERATION = parseHostedTaskBoardSourceGeneration('generation_standalone-read-1');
const REVISION = parseRevision(`revision_${'f'.repeat(64)}`);
const PRIVATE_FAILURE = 'provider token at /private/hosted-task-board';

interface AccessState {
  session: boolean;
  capability: boolean;
  workspaceGrant: boolean;
}

function mountBinding(): WorkspaceMountBinding {
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-standalone-task-board-read',
    workspaceId: WORKSPACE_ID,
    displayName: 'Standalone task board read',
    registrationRevision: 1,
    declaredRootHash: '1'.repeat(64),
    enabled: true,
  });
  return new WorkspaceMountBinding({
    registration,
    bootId: BOOT_ID,
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: NOW_MS,
    health: 'read-only',
    allowedOperations: [],
  });
}

function runtimeInstance() {
  return createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    claudeRoot: { kind: 'claude', reference: '/runtime/hosted-task-board/claude' },
    appDataRoot: { kind: 'app-data', reference: '/runtime/hosted-task-board/app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: '/runtime/hosted-task-board/workspace' }],
    tempRoot: { kind: 'temp', reference: '/runtime/hosted-task-board/temp' },
    logsRoot: { kind: 'logs', reference: '/runtime/hosted-task-board/logs' },
  });
}

function authenticatedPrincipal(): HostedAuthenticatedPrincipal {
  return Object.freeze({
    principal: Object.freeze({
      userId: USER_ID,
      displayName: 'Hosted task-board reader',
      role: 'viewer',
      permissions: Object.freeze(['hosted.query'] as const),
      authenticationMethod: 'oidc',
      sessionId: SESSION_ID,
    }),
    authenticatedSessionId: SESSION_ID,
  });
}

function found(): Extract<HostedTaskBoardAuthorityReadWindowResult, { kind: 'found' }> {
  return Object.freeze({
    kind: 'found',
    teamId: TEAM_ID,
    sourceGeneration: SOURCE_GENERATION,
    revision: REVISION,
    items: Object.freeze([
      Object.freeze({
        teamId: TEAM_ID,
        taskId: TASK_ID,
        subject: 'Mounted standalone read',
        description: null,
        status: 'pending' as const,
        ownerId: null,
        column: 'todo' as const,
        order: 0,
        blockedByTaskIds: Object.freeze([]),
        blocksTaskIds: Object.freeze([]),
        relatedTaskIds: Object.freeze([]),
      }),
    ]),
    hasMore: false,
    truncatedBy: null,
    degradedReasons: Object.freeze([]),
  });
}

function readRequest() {
  return Object.freeze({
    schemaVersion: 1,
    teamId: TEAM_ID,
    cursor: null,
    expectedSourceGeneration: null,
    limit: 25,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

function createComposition(
  source: HostedTaskBoardAuthorityPort,
  state: AccessState,
  failures: {
    readonly queryAfterSource?: () => boolean;
    readonly workspaceAfterSource?: () => boolean;
  } = {}
) {
  return createHostedTaskBoardReadComposition({
    authentication: Object.freeze({
      authenticatedPrincipalFor: () => (state.session ? authenticatedPrincipal() : null),
      isHostedQueryAuthorized: async () => {
        if (failures.queryAfterSource?.()) throw new Error(PRIVATE_FAILURE);
        return state.session && state.capability;
      },
      isTeamWorkspaceAuthorized: async () => {
        if (failures.workspaceAfterSource?.()) throw new Error(PRIVATE_FAILURE);
        return state.workspaceGrant;
      },
    }),
    runtimeInstance: runtimeInstance(),
    mountBinding: mountBinding(),
    teamIdentities: Object.freeze({
      listTeamIdentities: () => Promise.resolve([]),
      getTeamIdentity: () => Promise.resolve(null),
    }),
    expectedDeploymentId: DEPLOYMENT_ID,
    nowMs: () => NOW_MS,
    source,
  });
}

async function standaloneHttpApp(composition: ReturnType<typeof createComposition>) {
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
        projectWorkspaceId: () => Promise.resolve(null),
        projectPayload: () => Promise.resolve(null),
        projectEvent: () => Promise.resolve(null),
        isEventStreamAuthorized: () => Promise.resolve(false),
      },
      hostedTeamTaskBoardRoutes: composition,
    } as never,
    () => Promise.resolve()
  );
  await app.ready();
  return app;
}

describe('standalone hosted task-board read mounting', () => {
  it('constructs one deployment-bound composition and passes it to HttpServices', () => {
    const source = readFileSync(resolve('src/main/standalone.ts'), 'utf8');

    expect(source.match(/createHostedTaskBoardReadRouteFactory\(\{/g)).toHaveLength(1);
    expect(source).toContain(
      'createHostedTaskBoardReadRoutes = createHostedTaskBoardReadRouteFactory({'
    );
    expect(source).toContain('runtimeInstance: bootstrap.runtimeInstance');
    expect(source).toContain('mountBinding: bootstrap.mountBinding');
    expect(source).toContain('teamIdentities: teamIdentityGateway');
    expect(source).toContain(
      'const hostedTeamTaskBoardRoutes = createHostedTaskBoardReadRoutes?.(hostedAccessFeature);'
    );
    expect(source).toMatch(
      /const services: HttpServices = \{[\s\S]*hostedTeamTaskBoardRoutes,[\s\S]*\};/
    );
  });

  it('mounts the standalone read endpoint and leaves the mutation endpoint absent', async () => {
    const source: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(() => Promise.resolve(found())),
    };
    const app = await standaloneHttpApp(
      createComposition(source, { session: true, capability: true, workspaceGrant: true })
    );

    try {
      const page = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_PAGE_ROUTE,
        payload: readRequest(),
      });
      const mutation = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_MUTATION_ROUTE,
        payload: {},
      });

      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({
        kind: 'task_board_page',
        teamId: TEAM_ID,
        items: [{ subject: 'Mounted standalone read' }],
      });
      expect(mutation.statusCode).toBe(404);
      expect(source.readWindow).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    [
      'session',
      (state: AccessState) => {
        state.session = false;
      },
    ],
    [
      'capability',
      (state: AccessState) => {
        state.capability = false;
      },
    ],
    [
      'workspace grant',
      (state: AccessState) => {
        state.workspaceGrant = false;
      },
    ],
  ] as const)(
    'does not return protected task data when the %s is revoked while the source is pending',
    async (_name, revoke) => {
      const state: AccessState = { session: true, capability: true, workspaceGrant: true };
      const sourceEntered = deferred<void>();
      const sourceResult = deferred<HostedTaskBoardAuthorityReadWindowResult>();
      const source: HostedTaskBoardAuthorityPort = {
        readWindow: vi.fn(async () => {
          sourceEntered.resolve();
          return sourceResult.promise;
        }),
      };
      const app = await standaloneHttpApp(createComposition(source, state));

      try {
        const pending = app.inject({
          method: 'POST',
          url: HOSTED_TASK_BOARD_PAGE_ROUTE,
          payload: readRequest(),
        });
        await sourceEntered.promise;
        revoke(state);
        sourceResult.resolve(found());

        const response = await pending;
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'unavailable', reason: 'task_board_unavailable' },
          retryable: true,
        });
        expect(response.body).not.toContain('Mounted standalone read');
        expect(response.body).not.toContain(TASK_ID);
        expect(source.readWindow).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    }
  );

  it.each(['source', 'query revalidation', 'workspace revalidation'] as const)(
    'contains opaque %s failures in the generic unavailable response',
    async (failure) => {
      const state: AccessState = { session: true, capability: true, workspaceGrant: true };
      let sourceResolved = false;
      const source: HostedTaskBoardAuthorityPort = {
        readWindow: vi.fn(async () => {
          sourceResolved = true;
          if (failure === 'source') throw new Error(PRIVATE_FAILURE);
          return found();
        }),
      };
      const app = await standaloneHttpApp(
        createComposition(source, state, {
          queryAfterSource: () => failure === 'query revalidation' && sourceResolved,
          workspaceAfterSource: () => failure === 'workspace revalidation' && sourceResolved,
        })
      );

      try {
        const response = await app.inject({
          method: 'POST',
          url: HOSTED_TASK_BOARD_PAGE_ROUTE,
          payload: readRequest(),
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'unavailable', reason: 'task_board_unavailable' },
          retryable: true,
        });
        expect(response.body).not.toContain(PRIVATE_FAILURE);
        expect(response.body).not.toContain('/private');
      } finally {
        await app.close();
      }
    }
  );
});
