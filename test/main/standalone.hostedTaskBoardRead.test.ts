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
  type HostedTaskBoardAuthorityMutationRequest,
  type HostedTaskBoardAuthorityMutationResult,
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowResult,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
  parseHostedTaskIdempotencyKey,
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
const COMMAND_ID = parseHostedTaskCommandId('command_standalone-mutation-1');
const IDEMPOTENCY_KEY = parseHostedTaskIdempotencyKey('idempotency_standalone-mutation-1');
const PRIVATE_FAILURE = 'provider token at /private/hosted-task-board';

interface AccessState {
  session: boolean;
  capability: boolean;
  workspaceGrant: boolean;
  csrf?: boolean;
  mutationCapability?: boolean;
}

function mountBinding(health: 'healthy' | 'read-only' = 'read-only'): WorkspaceMountBinding {
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
    health,
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

function authenticatedPrincipal(mutationCapability = false): HostedAuthenticatedPrincipal {
  return Object.freeze({
    principal: Object.freeze({
      userId: USER_ID,
      displayName: 'Hosted task-board reader',
      role: mutationCapability ? 'member' : 'viewer',
      permissions: Object.freeze(
        mutationCapability
          ? (['hosted.query', 'hosted.command'] as const)
          : (['hosted.query'] as const)
      ),
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

function mutationRequest() {
  return Object.freeze({
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    teamId: TEAM_ID,
    expectedSourceGeneration: SOURCE_GENERATION,
    expectedRevision: REVISION,
    kind: 'update_status' as const,
    taskId: TASK_ID,
    status: 'completed' as const,
  });
}

function committedMutation(
  request: HostedTaskBoardAuthorityMutationRequest
): HostedTaskBoardAuthorityMutationResult {
  return Object.freeze({
    kind: 'committed' as const,
    currentSourceGeneration: SOURCE_GENERATION,
    payloadFingerprint: request.payloadFingerprint,
    receipt: Object.freeze({
      schemaVersion: 1 as const,
      outcome: 'committed' as const,
      commandId: request.command.commandId,
      teamId: request.command.teamId,
      sourceGeneration: SOURCE_GENERATION,
      revision: REVISION,
      affectedTaskIds: Object.freeze([TASK_ID]),
    }),
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
  } = {},
  options: {
    readonly mountHealth?: 'healthy' | 'read-only';
    readonly mutationAuthority?: Pick<HostedTaskBoardAuthorityPort, 'admitTaskMutation'>;
  } = {}
) {
  return createHostedTaskBoardReadComposition({
    authentication: Object.freeze({
      authenticatedPrincipalFor: () =>
        state.session ? authenticatedPrincipal(state.mutationCapability === true) : null,
      isHostedQueryAuthorized: async () => {
        if (failures.queryAfterSource?.()) throw new Error(PRIVATE_FAILURE);
        return state.session && state.capability;
      },
      isHostedTaskMutationAuthorized: async () =>
        state.session &&
        state.capability &&
        state.workspaceGrant &&
        state.csrf !== false &&
        state.mutationCapability === true,
      isTeamWorkspaceAuthorized: async () => {
        if (failures.workspaceAfterSource?.()) throw new Error(PRIVATE_FAILURE);
        return state.workspaceGrant;
      },
    }),
    runtimeInstance: runtimeInstance(),
    mountBinding: mountBinding(options.mountHealth),
    teamIdentities: Object.freeze({
      listTeamIdentities: () => Promise.resolve([]),
      getTeamIdentity: () => Promise.resolve(null),
    }),
    expectedDeploymentId: DEPLOYMENT_ID,
    nowMs: () => NOW_MS,
    source,
    mutationAuthority: options.mutationAuthority,
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

    expect(
      source.match(
        /createHostedTaskBoardReadRoutes\s*=\s*createHostedTaskBoardReadRouteFactory\s*\([^)]*\)/g
      )
    ).toHaveLength(1);
    expect(source).toContain('runtimeInstance: bootstrap.runtimeInstance');
    expect(source).toContain('mountBinding: bootstrap.mountBinding');
    expect(source).toContain('teamIdentities: teamIdentityGateway');
    expect(source).toContain(
      'hostedTeamTaskBoardRoutes = createHostedTaskBoardReadRoutes?.(hostedAccessFeature);'
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

  it('mounts Core v1 task mutation only with a healthy writable authority', async () => {
    const source: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(() => Promise.resolve(found())),
    };
    const admitTaskMutation = vi.fn(async (request: HostedTaskBoardAuthorityMutationRequest) =>
      committedMutation(request)
    );
    const composition = createComposition(
      source,
      { session: true, capability: true, workspaceGrant: true, mutationCapability: true },
      {},
      { mountHealth: 'healthy', mutationAuthority: { admitTaskMutation } }
    );
    expect(composition.mutationsEnabled).toBe(false);
    const app = await standaloneHttpApp(composition);

    try {
      expect(composition.mutationsEnabled).toBe(true);
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_MUTATION_ROUTE,
        payload: mutationRequest(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        outcome: 'committed',
        commandId: COMMAND_ID,
        teamId: TEAM_ID,
        sourceGeneration: SOURCE_GENERATION,
        revision: REVISION,
        affectedTaskIds: [TASK_ID],
      });
      expect(admitTaskMutation).toHaveBeenCalledWith(
        expect.objectContaining({ command: mutationRequest() }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      await app.close();
    }
  });

  it('maps a writable authority stale generation to the safe mutation envelope', async () => {
    const currentSourceGeneration = parseHostedTaskBoardSourceGeneration(
      'generation_standalone-current'
    );
    const source: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(() => Promise.resolve(found())),
    };
    const app = await standaloneHttpApp(
      createComposition(
        source,
        { session: true, capability: true, workspaceGrant: true, mutationCapability: true },
        {},
        {
          mountHealth: 'healthy',
          mutationAuthority: {
            admitTaskMutation: vi.fn(async () =>
              Object.freeze({ kind: 'stale_generation' as const, currentSourceGeneration })
            ),
          },
        }
      )
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TASK_BOARD_MUTATION_ROUTE,
        payload: mutationRequest(),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        kind: 'error',
        error: { code: 'conflict', reason: 'stale_generation' },
        retryable: false,
        currentSourceGeneration,
      });
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
      'workspace grant',
      (state: AccessState) => {
        state.workspaceGrant = false;
      },
    ],
    [
      'CSRF state',
      (state: AccessState) => {
        state.csrf = false;
      },
    ],
  ] as const)(
    'does not return a mutation receipt when the %s is revoked while authority work is pending',
    async (_name, revoke) => {
      const state: AccessState = {
        session: true,
        capability: true,
        workspaceGrant: true,
        mutationCapability: true,
      };
      const authorityEntered = deferred<void>();
      const authorityResult = deferred<HostedTaskBoardAuthorityMutationResult>();
      let admittedRequest: HostedTaskBoardAuthorityMutationRequest | null = null;
      const source: HostedTaskBoardAuthorityPort = {
        readWindow: vi.fn(() => Promise.resolve(found())),
      };
      const app = await standaloneHttpApp(
        createComposition(
          source,
          state,
          {},
          {
            mountHealth: 'healthy',
            mutationAuthority: {
              admitTaskMutation: vi.fn(async (request: HostedTaskBoardAuthorityMutationRequest) => {
                admittedRequest = request;
                authorityEntered.resolve();
                return authorityResult.promise;
              }),
            },
          }
        )
      );

      try {
        const pending = app.inject({
          method: 'POST',
          url: HOSTED_TASK_BOARD_MUTATION_ROUTE,
          payload: mutationRequest(),
        });
        await authorityEntered.promise;
        revoke(state);
        if (admittedRequest === null)
          throw new Error('synthetic mutation authority did not receive a request');
        authorityResult.resolve(committedMutation(admittedRequest));

        const response = await pending;
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'unavailable', reason: 'task_board_unavailable' },
          retryable: true,
        });
        expect(response.body).not.toContain(COMMAND_ID);
        expect(response.body).not.toContain(TASK_ID);
      } finally {
        await app.close();
      }
    }
  );

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
