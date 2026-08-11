import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type HostedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access/contracts';
import { HostedAuthHttpController } from '@features/hosted-access/main/adapters/input/http/HostedAuthHttpController';
import { InternalStorageHostedAccessRepository } from '@features/hosted-access/main/adapters/output/InternalStorageHostedAccessRepository';
import {
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
} from '@features/hosted-operations/contracts';
import { HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS } from '@features/hosted-operations/main/hosted';
import { parseTeamIdentityRecord } from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS } from '@features/team-lifecycle/main/hosted';
import {
  HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  HOSTED_TEAM_MESSAGE_SEND_ROUTE,
  type HostedTeamMessageAuthorityPort,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/main/hosted';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import {
  createQueryContext,
  parseAuthorizedScope,
  parseBootId,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { NodeHostedQueryContextIdentity } from '../../src/features/hosted-query-context/main/infrastructure/NodeHostedQueryContextIdentity';
import { HostedTeamInboxAuthority } from '../../src/features/team-message-delivery/main/composition/AuthorizedHostedTeamMessageAuthority';
import { DescriptorSafeHostedInboxReader } from '../../src/features/team-message-delivery/main/infrastructure/DescriptorSafeHostedInboxReader';
import {
  createHostedRouteAdmissionBinding,
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  type HostedRouteAdmissionBinding,
} from '../../src/main/composition/hosted/application';
import { createHostedDiagnosticsComposition } from '../../src/main/composition/hosted/hostedDiagnosticsComposition';
import {
  classifyHostedTeamMessageAuthorization,
  createHostedTeamMessageComposition,
} from '../../src/main/composition/hosted/hostedTeamMessageComposition';

import type { OidcAuthenticationCapability } from '@features/hosted-access';
import type { InboxMessage } from '@shared/types';

const USER_ID = parseUserId('user_diagnostics-user-0001');
const SESSION_ID = parseHostedSessionId('session_diagnostics-oidc-0001');
const SESSION_SECRET = 'opaque-diagnostics-session-secret';
const CSRF_TOKEN = 'csrf-diagnostics-token';
const DEPLOYMENT_ID = 'deployment_diagnostics-test';
const BOOT_ID = 'boot_diagnostics-test';
const PUBLIC_ORIGIN = 'https://agent-teams.test';
const PRIVATE_VALUE = '/private/provider/token-value';
const MESSAGE_TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const MESSAGE_WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const MESSAGE_ID = parseHostedMessageId(`message_${'c'.repeat(32)}`);
const MESSAGE_SOURCE_GENERATION = parseHostedMessageSourceGeneration(
  'generation_message-composition'
);

function routeAdmissionBinding(): HostedRouteAdmissionBinding {
  const dimensions = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => [
      dimension,
      Object.freeze({ dimension, status: 'ready' as const, reasons: Object.freeze([]) }),
    ])
  );
  return createHostedRouteAdmissionBinding({
    routes: [
      ...HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
      ...HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
    ],
    readiness: {
      readiness: async () =>
        Object.freeze({
          revision: 1,
          dimensions: Object.freeze({
            ...dimensions,
            terminal: HOSTED_TERMINAL_READINESS,
          }) as HostedReadinessDimensionStates,
        }),
    },
  });
}

function runtimeInstance(bootId = BOOT_ID) {
  return createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId,
    claudeRoot: { kind: 'claude', reference: '/synthetic/hosted-diagnostics/claude' },
    appDataRoot: { kind: 'app-data', reference: '/synthetic/hosted-diagnostics/app-data' },
    workspaceRoots: [],
    tempRoot: { kind: 'temp', reference: '/synthetic/hosted-diagnostics/temp' },
    logsRoot: { kind: 'logs', reference: '/synthetic/hosted-diagnostics/logs' },
  });
}

function principal(permissions: HostedPrincipal['permissions']): HostedPrincipal {
  return Object.freeze({
    userId: USER_ID,
    displayName: 'Diagnostics user',
    role: 'viewer',
    permissions: Object.freeze([...permissions]),
    authenticationMethod: 'oidc',
    sessionId: SESSION_ID,
  });
}

function messageMountBinding(): WorkspaceMountBinding {
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-message-composition',
    workspaceId: MESSAGE_WORKSPACE_ID,
    displayName: 'Message composition workspace',
    registrationRevision: 1,
    declaredRootHash: 'd'.repeat(64),
    enabled: true,
  });
  return new WorkspaceMountBinding({
    registration,
    bootId: parseBootId(BOOT_ID),
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: 1,
    health: 'read-only',
    allowedOperations: [],
  });
}

function messageAuthority(): HostedTeamMessageAuthorityPort {
  return {
    bindGrantFence: () => undefined,
    readWindow: async (request) =>
      Object.freeze({
        kind: 'found' as const,
        teamId: request.teamId,
        sourceGeneration: MESSAGE_SOURCE_GENERATION,
        revision: parseRevision('revision_message-composition'),
        messages: Object.freeze([
          Object.freeze({
            teamId: request.teamId,
            messageId: MESSAGE_ID,
            direction: 'team' as const,
            text: 'Bounded team reply.',
            createdAtMs: 1,
          }),
        ]),
        hasMore: false,
      }),
    persistMessage: async (command) =>
      Object.freeze({
        kind: 'persisted' as const,
        receipt: Object.freeze({
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: command.teamId,
          messageId: MESSAGE_ID,
          clientMessageId: command.clientMessageId,
          persistence: 'durable' as const,
        }),
      }),
    deliverPersistedMessage: async () => Object.freeze({ kind: 'operator_required' as const }),
  };
}

function activeMessageIdentity() {
  return parseTeamIdentityRecord({
    teamId: MESSAGE_TEAM_ID,
    state: 'active',
    legacyKey: 'message-composition-team',
    directoryFingerprint: 'e'.repeat(64),
    workspaceBinding: { workspaceId: MESSAGE_WORKSPACE_ID, generation: 1 },
    adoptionIntentId: `adoption_${'f'.repeat(32)}`,
    identityChecksum: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    activatedAt: '2026-01-01T00:00:01.000Z',
    tombstonedAt: null,
  });
}

function inboxMessage(input: {
  readonly from: string;
  readonly messageId: string;
  readonly messageKind?: InboxMessage['messageKind'];
  readonly text: string;
  readonly timestamp: string;
  readonly to?: string;
}): InboxMessage {
  return {
    from: input.from,
    to: input.to,
    text: input.text,
    timestamp: input.timestamp,
    read: true,
    messageId: input.messageId,
    messageKind: input.messageKind,
  };
}

async function harness(
  permissions: HostedPrincipal['permissions'] = ['hosted.query'],
  runtime: ReturnType<typeof runtimeInstance> | null = runtimeInstance()
) {
  const app = Fastify();
  const authentication = {
    mode: 'oidc',
    displayName: 'Synthetic identity provider',
    authenticate: (input: { readonly sessionSecret?: string }) =>
      Promise.resolve(
        input.sessionSecret === SESSION_SECRET
          ? Object.freeze({
              authenticated: true,
              context: Object.freeze({
                principal: principal(permissions),
                authenticatedSessionId: SESSION_ID,
                sessionSecret: SESSION_SECRET,
                csrfToken: CSRF_TOKEN,
              }),
              replacementDeviceSecret: null,
            })
          : Object.freeze({ authenticated: false, reason: 'invalid' })
      ),
    verifyCsrf: (_context: unknown, token: string) => Promise.resolve(token === CSRF_TOKEN),
    auditAuthorization: () => Promise.resolve(),
  } as unknown as OidcAuthenticationCapability;
  const repository = {
    isWorkspaceRegistered: () => Promise.resolve(false),
    listWorkspaceGrants: () => Promise.resolve([]),
    listWorkspaces: () => Promise.resolve([]),
  } as unknown as InternalStorageHostedAccessRepository;
  const auth = new HostedAuthHttpController({
    mode: 'oidc',
    publicOrigin: PUBLIC_ORIGIN,
    secureCookies: true,
    authentication,
    personal: null,
    oidc: authentication,
    repository,
    restoreGeneration: 0,
    sessionMaxAgeSeconds: 600,
    deviceMaxAgeSeconds: 600,
    tryEnterPublicRequest: () => true,
    leavePublicRequest: () => undefined,
    isPublicAccessActive: () => true,
  });
  const composition = createHostedDiagnosticsComposition({
    authentication: Object.freeze({
      allowedOrigin: PUBLIC_ORIGIN,
      register: (target: unknown) => auth.register(target),
      authenticatedPrincipalFor: (request: object) => auth.authenticatedPrincipalFor(request),
      isWorkspaceRegistered: (workspaceId: string) => auth.isWorkspaceRegistered(workspaceId),
      projectWorkspaceId: (request: unknown, workspaceId: string) =>
        auth.projectWorkspaceId(request, workspaceId),
      projectPayload: (request: unknown, payload: unknown) => auth.projectPayload(request, payload),
      isEventStreamAuthorized: (request: unknown) => auth.isEventStreamAuthorized(request),
      projectEvent: (request: unknown, channel: string, data: unknown) =>
        auth.projectEvent(request, channel, data),
    }),
    runtimeInstance: runtime,
    expectedDeploymentId: DEPLOYMENT_ID,
    routeAdmissionBinding: routeAdmissionBinding(),
  });
  auth.register(app);
  composition.register(app);
  await app.ready();
  return { app, composition };
}

const authenticatedHeaders = Object.freeze({
  cookie: `__Host-agent-teams-session=${SESSION_SECRET}`,
  origin: PUBLIC_ORIGIN,
  'sec-fetch-site': 'same-origin',
  'x-agent-teams-csrf': CSRF_TOKEN,
});

describe('standalone hosted diagnostics', () => {
  it('mounts one auth-bound composition from canonical bootstrap identity and closes it', () => {
    const source = readFileSync(resolve('src/main/standalone.ts'), 'utf8');
    const shutdown = source.slice(source.indexOf('async function shutdown'));

    expect(source.match(/createHostedDiagnosticsComposition\(\{/g)).toHaveLength(1);
    expect(source).toContain('authentication: hostedAccessFeature.http');
    expect(source).toContain('runtimeInstance: hostedDiagnosticsRuntimeInstance');
    expect(source).toContain('expectedDeploymentId: hostedAccessFeature.deploymentId');
    expect(source.match(/createHostedRouteAdmissionBinding\(\{/g)).toHaveLength(1);
    expect(source).toContain('...HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS');
    expect(source).toContain(
      'productionOwnerAdmission === null ? [] : HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS'
    );
    expect(source).toContain('routeAdmissionBinding: hostedRouteAdmissionBinding');
    expect(source).toContain('hostedDiagnosticsRoutes: hostedDiagnostics');
    expect(source).toContain('hostedDiagnosticsRuntimeInstance = bootstrap.runtimeInstance');
    expect(shutdown.indexOf('hostedDiagnostics?.close()')).toBeLessThan(
      shutdown.indexOf('httpServer.stop()')
    );
    expect(source).not.toMatch(
      /(?:new HostedApplication|new HostedLifecycle|HostedTeamWorkspace\b)/
    );
  });

  it('serves only an authenticated, CSRF-admitted, bounded redacted response', async () => {
    const { app, composition } = await harness();
    const identity = new NodeHostedQueryContextIdentity();
    const referenceId = composition.recorder.record(
      {
        kind: 'reference_load',
        outcome: 'succeeded',
        occurredAtMonotonicMs: 1,
        attributes: { component: PRIVATE_VALUE, token: PRIVATE_VALUE },
      },
      createQueryContext({
        actorId: identity.projectActorId(USER_ID),
        sessionId: identity.projectSessionId(SESSION_ID),
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
        requestId: 'request_diagnostics-record-0001',
        authorizedScope: parseAuthorizedScope('scope_authenticated-hosted-query'),
        deadlineAtMs: Date.now() + 10_000,
        signal: new AbortController().signal,
      })
    );
    const payload = {
      schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
      referenceIds: [referenceId],
    };
    try {
      const anonymous = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        payload,
      });
      expect(anonymous.statusCode).toBe(401);

      const invalidCsrf = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: { ...authenticatedHeaders, 'x-agent-teams-csrf': 'invalid' },
        payload,
      });
      expect(invalidCsrf.statusCode).toBe(403);

      const response = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.json()).toMatchObject({
        schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
        kind: 'success',
        items: [
          {
            referenceId,
            attributes: { component: 'redacted' },
          },
        ],
      });
      for (const hidden of [
        PRIVATE_VALUE,
        USER_ID,
        SESSION_ID,
        SESSION_SECRET,
        CSRF_TOKEN,
        BOOT_ID,
      ]) {
        expect(response.body).not.toContain(hidden);
      }
    } finally {
      composition.close();
      await app.close();
    }
  });

  it('fails closed for missing permission/runtime, wrong deployment, and closed adapters', async () => {
    expect(() =>
      createHostedDiagnosticsComposition({
        authentication: {} as never,
        runtimeInstance: runtimeInstance('boot_diagnostics-other'),
        expectedDeploymentId: 'deployment_diagnostics-other',
        routeAdmissionBinding: routeAdmissionBinding(),
      })
    ).toThrow('hosted-diagnostics-deployment-binding-invalid');

    const unavailable = await harness(['hosted.query'], null);
    try {
      const response = await unavailable.app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload: { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: [] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ kind: 'error' });
    } finally {
      unavailable.composition.close();
      await unavailable.app.close();
    }

    const denied = await harness(['hosted.events']);
    try {
      const response = await denied.app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload: { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: [] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ kind: 'error' });

      denied.composition.close();
      const closed = await denied.app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        headers: authenticatedHeaders,
        payload: { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: [] },
      });
      expect(closed.statusCode).toBe(503);
    } finally {
      denied.composition.close();
      await denied.app.close();
    }
  });
});

describe('standalone hosted team messages', () => {
  it('freezes the exact desktop main barrel while hosted callers use the hosted entrypoint', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/team-message-delivery/main/index.ts'),
      'utf8'
    );
    expect(source).toBe(`export {
  createDesktopTeamMessageDeliveryFeature,
  type DesktopTeamMessageDeliveryCompatibilityHost,
  type DesktopTeamMessageDeliveryFeature,
  type DesktopTeamMessageDeliveryFeatureDependencies,
  registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc,
  type TeamMessageDeliveryIpcDependencies,
  type TeamMessageDeliveryIpcMainPort,
  type TeamMessageDeliveryRepositoryPort,
} from './composition/createDesktopTeamMessageDeliveryFeature';
export {
  createHostedTeamMessageRouteContribution,
  type CreateHostedTeamMessageRouteContributionDependencies,
  createHostedTeamMessageRouteFactory,
  type HostedTeamMessageRouteAccess,
  type HostedTeamMessageRouteContribution,
  type HostedTeamMessageRouteFactory,
} from './composition/createHostedTeamMessageRouteContribution';
export {
  createTeamMessageDeliveryFeature,
  createTeamMessagePersistenceFacade,
  type TeamMessageDeliveryFeature,
  type TeamMessageDeliveryFeatureDependencies,
  type TeamMessageLeadResolutionPort,
  type TeamMessagePersistenceCoordinatorPorts,
  type TeamMessagePersistenceFacade,
  type TeamMessageSystemNotificationPort,
} from './composition/createTeamMessageDeliveryFeature';
`);
  });

  it.each([
    [HOSTED_TEAM_MESSAGE_PAGE_ROUTE, 'hosted.query'],
    [`${HOSTED_TEAM_MESSAGE_SEND_ROUTE}?trace=bounded`, 'hosted.command'],
  ] as const)('classifies the exact POST route %s', (url, permission) => {
    expect(classifyHostedTeamMessageAuthorization('POST', url)).toEqual({
      kind: 'authenticated',
      permission,
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    });
  });

  it.each([
    ['near path', 'POST', `${HOSTED_TEAM_MESSAGE_PAGE_ROUTE}/`],
    ['wrong method', 'GET', HOSTED_TEAM_MESSAGE_SEND_ROUTE],
    ['unknown route', 'POST', '/api/hosted/v1/team-messages/unknown'],
  ] as const)(
    'classifies the %s as forbidden for the auth controller 404',
    (_case, method, url) => {
      expect(classifyHostedTeamMessageAuthorization(method, url)).toEqual({ kind: 'forbidden' });
    }
  );

  it('mounts the one auth-bound message composition without taking lifecycle ownership', () => {
    const source = readFileSync(resolve('src/main/standalone.ts'), 'utf8');
    const composition = readFileSync(
      resolve('src/main/composition/hosted/hostedTeamMessageComposition.ts'),
      'utf8'
    );

    expect(source.match(/createHostedTeamMessageRouteFactory\(/g)).toHaveLength(1);
    expect(source).toContain('hostedTeamMessageRouteDependencies = {');
    expect(source).toContain('teamIdentities: hostedTeamMessageRouteDependencies.teamIdentities');
    expect(source).toContain(
      'hostedTeamMessageRoutes: createHostedTeamMessageRoutes?.(hostedAccessFeature)'
    );
    expect(source).toContain(
      'hostedLifecycleCommands?.isReady() === true && hostedTeamMessageWriter !== null'
    );
    expect(source).toMatch(
      /hostedLifecycleCommands\?\.isReady\(\) === true &&\s+hostedTeamTaskBoardRoutes\?\.mutationsEnabled === true/
    );
    expect(source).toContain('teamIdentities: teamIdentityGateway');
    expect(source).not.toMatch(
      /(?:new HostedApplication|new HostedLifecycle|HostedTeamWorkspace\b)/
    );
    expect(composition).toContain("from '@features/team-message-delivery/main'");
    expect(composition).not.toContain("from '@features/team-message-delivery/contracts'");
    expect(composition).not.toMatch(
      /(?:canonicalText|activeLeadName|TeamInbox(?:Reader|Writer)|createAuthenticatedHostedQueryContextFactory)/
    );
  });

  it('advances raw inbox windows so visible messages beyond 1,280 rows remain paginable', async () => {
    const rawMessages = Object.freeze([
      ...Array.from({ length: 1_280 }, (_, index) =>
        inboxMessage({
          from: 'system',
          to: 'user',
          messageId: `hidden-${String(index).padStart(4, '0')}`,
          messageKind: 'slash_command',
          text: `Hidden control row ${index}.`,
          timestamp: new Date(Date.UTC(2026, 0, 4, 0, 0, -index)).toISOString(),
        })
      ),
      inboxMessage({
        from: 'lead',
        to: 'user',
        messageId: 'visible-after-window-newest',
        messageKind: 'default',
        text: 'Newest visible message after the raw window.',
        timestamp: new Date(Date.UTC(2026, 0, 4, 0, 0, -1_280)).toISOString(),
      }),
      inboxMessage({
        from: 'lead',
        to: 'user',
        messageId: 'visible-after-window-older',
        messageKind: 'default',
        text: 'Older visible message after the raw window.',
        timestamp: new Date(Date.UTC(2026, 0, 4, 0, 0, -1_281)).toISOString(),
      }),
    ]);
    const getMessagesWindow = vi
      .spyOn(DescriptorSafeHostedInboxReader.prototype, 'getMessagesWindow')
      .mockImplementation(async (_teamName, options) => {
        const cursor = options.cursor ?? null;
        const startIndex =
          cursor === null
            ? 0
            : rawMessages.findIndex(
                (message) =>
                  Date.parse(message.timestamp) === cursor.timestampMs &&
                  message.messageId === cursor.messageId
              ) + 1;
        const messages = rawMessages.slice(startIndex, startIndex + options.limit);
        return {
          messages,
          truncated: startIndex + messages.length < rawMessages.length,
          sourceRevision: 'message-composition-visible-window',
          sourceMessageCount: rawMessages.length,
        };
      });
    const app = Fastify();
    const activeRequests = new WeakSet<object>();
    const authentication = {
      authenticatedPrincipalFor: (request: object) =>
        activeRequests.has(request)
          ? Object.freeze({
              principal: principal(['hosted.query']),
              authenticatedSessionId: SESSION_ID,
            })
          : null,
      isHostedQueryAuthorized: (request: object) => Promise.resolve(activeRequests.has(request)),
      isHostedTaskMutationAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      isTeamWorkspaceAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      captureTeamWorkspaceGrantFence: async () =>
        Object.freeze({
          ownerEffectFence: Object.freeze({
            grantRevision: 'b'.repeat(64),
            identityChecksum: 'a'.repeat(64),
          }),
          revalidate: async () => true,
        }),
    };
    app.addHook('onRequest', async (request) => {
      activeRequests.add(request);
    });
    const composition = createHostedTeamMessageComposition({
      authentication,
      runtimeInstance: runtimeInstance(),
      mountBinding: messageMountBinding(),
      teamIdentities: {
        listTeamIdentities: () => Promise.resolve(Object.freeze([activeMessageIdentity()])),
        getTeamIdentity: (teamId) =>
          Promise.resolve(teamId === MESSAGE_TEAM_ID ? activeMessageIdentity() : null),
      },
      expectedDeploymentId: DEPLOYMENT_ID,
    });
    composition.register(app);
    await app.ready();

    try {
      const first = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
        payload: {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: MESSAGE_TEAM_ID,
          cursor: null,
          expectedSourceGeneration: null,
          limit: 1,
        },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        messages: [{ text: 'Newest visible message after the raw window.' }],
      });
      expect(getMessagesWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          legacyKey: 'message-composition-team',
          directoryFingerprint: 'e'.repeat(64),
          identityChecksum: 'a'.repeat(64),
        }),
        expect.objectContaining({ cursor: null, limit: 1_280 })
      );
      expect(getMessagesWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          legacyKey: 'message-composition-team',
          directoryFingerprint: 'e'.repeat(64),
          identityChecksum: 'a'.repeat(64),
        }),
        expect.objectContaining({
          cursor: expect.objectContaining({ messageId: 'hidden-1279' }),
          limit: 1_280,
        })
      );

      const firstPage = first.json() as {
        readonly nextCursor: string;
        readonly sourceGeneration: string;
      };
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const second = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
        payload: {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: MESSAGE_TEAM_ID,
          cursor: firstPage.nextCursor,
          expectedSourceGeneration: firstPage.sourceGeneration,
          limit: 1,
        },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        messages: [{ text: 'Older visible message after the raw window.' }],
        nextCursor: null,
      });
    } finally {
      getMessagesWindow.mockRestore();
      await app.close();
    }
  });

  it('rejects an inbox snapshot when its exact active team identity changes during the read', async () => {
    const initialIdentity = activeMessageIdentity();
    const changedIdentity = parseTeamIdentityRecord({
      ...initialIdentity,
      identityChecksum: 'b'.repeat(64),
    });
    let identityReads = 0;
    const authority = new HostedTeamInboxAuthority({
      runtimeInstance: runtimeInstance(),
      mountBinding: messageMountBinding(),
      teamIdentities: {
        listTeamIdentities: () => Promise.resolve(Object.freeze([initialIdentity])),
        getTeamIdentity: () => {
          identityReads += 1;
          return Promise.resolve(identityReads === 1 ? initialIdentity : changedIdentity);
        },
      },
      inboxReader: {
        getMessagesWindow: () =>
          Promise.resolve({
            messages: [
              inboxMessage({
                from: 'lead',
                to: 'user',
                messageId: 'identity-race-message',
                messageKind: 'default',
                text: 'This stale identity snapshot must not escape.',
                timestamp: '2026-01-04T00:00:00.000Z',
              }),
            ],
            truncated: false,
            sourceRevision: 'identity-race-source',
            sourceMessageCount: 1,
          }),
      },
    });
    const queryContext = createQueryContext({
      actorId: 'actor_message-identity-race',
      sessionId: 'session_message-identity-race',
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      requestId: 'request_message-identity-race',
      authorizedScope: parseAuthorizedScope('scope_message-identity-race'),
      deadlineAtMs: Date.now() + 10_000,
      signal: new AbortController().signal,
    });

    await expect(
      authority.readWindow(
        {
          teamId: MESSAGE_TEAM_ID,
          afterMessageId: null,
          expectedSourceGeneration: null,
          itemLimit: 25,
          deadlineAtMs: queryContext.deadlineAtMs,
        },
        queryContext
      )
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(identityReads).toBe(2);
  });

  it.each([
    ['from', { from: 'forged-member' }],
    ['to', { to: 'forged-target' }],
    ['descriptor target', { hostedInboxTarget: 'forged-target' }],
  ] as const)(
    'does not classify copied owner provenance as operator-authored after the %s changes',
    async (_case, messagePatch) => {
      const ownerProofKey = 'ab'.repeat(32);
      const ownerBinding = Object.freeze({
        ownerAuthority: 'owner-authority_message-provenance',
        ownerGeneration: 7,
        ownerSessionId: 'owner-session_message-provenance-0007',
      });
      const timestamp = '2026-01-04T00:00:00.000Z';
      const text = 'Authenticated operator message.';
      const unsigned = Object.freeze({
        schemaVersion: 1,
        domain: 'agent-teams.hosted-team-message.inbox-provenance/v1',
        actorId: 'actor_message-provenance',
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
        workspaceId: MESSAGE_WORKSPACE_ID,
        mountGeneration: 1,
        teamId: MESSAGE_TEAM_ID,
        messageId: 'raw-owner-provenance-message',
        from: 'user',
        to: 'team-lead',
        target: 'team-lead',
        textHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        createdAtMs: Date.parse(timestamp),
        ...ownerBinding,
      });
      const ownerProof = createHmac('sha256', Buffer.from(ownerProofKey, 'hex'))
        .update(
          `agent-teams.hosted-team-message.inbox-provenance/v1\u0000${JSON.stringify(unsigned)}`,
          'utf8'
        )
        .digest('hex');
      const signedMessage = Object.freeze({
        from: 'user',
        to: 'team-lead',
        hostedInboxTarget: 'team-lead',
        text,
        timestamp,
        read: false,
        messageId: unsigned.messageId,
        hostedOwnerProvenance: Object.freeze({ ...unsigned, ownerProof }),
      });
      const queryContext = createQueryContext({
        actorId: 'actor_message-provenance',
        sessionId: 'session_message-provenance',
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
        requestId: 'request_message-provenance',
        authorizedScope: parseAuthorizedScope('scope_message-provenance'),
        deadlineAtMs: Date.now() + 10_000,
        signal: new AbortController().signal,
      });
      const readDirection = async (message: typeof signedMessage): Promise<string | undefined> => {
        const authority = new HostedTeamInboxAuthority({
          runtimeInstance: runtimeInstance(),
          mountBinding: messageMountBinding(),
          teamIdentities: {
            listTeamIdentities: () => Promise.resolve(Object.freeze([activeMessageIdentity()])),
            getTeamIdentity: () => Promise.resolve(activeMessageIdentity()),
          },
          ownerProvenance: {
            ownerProofKey,
            currentOwnerBinding: () => ownerBinding,
          },
          inboxReader: {
            getMessagesWindow: () =>
              Promise.resolve({
                messages: [message],
                truncated: false,
                sourceRevision: 'owner-provenance-source',
                sourceMessageCount: 1,
              }),
          },
        });
        const result = await authority.readWindow(
          {
            teamId: MESSAGE_TEAM_ID,
            afterMessageId: null,
            expectedSourceGeneration: null,
            itemLimit: 25,
            deadlineAtMs: queryContext.deadlineAtMs,
          },
          queryContext
        );
        return result.kind === 'found' ? result.messages[0]?.direction : undefined;
      };

      await expect(readDirection(signedMessage)).resolves.toBe('operator');
      await expect(
        readDirection(
          Object.freeze({ ...signedMessage, ...messagePatch }) as unknown as typeof signedMessage
        )
      ).resolves.toBe('team');
    }
  );

  it('fails closed before mutating a lead inbox on the read-only mount authority', async () => {
    const app = Fastify();
    const activeRequests = new WeakSet<object>();
    const sendMessage = vi.spyOn(TeamInboxWriter.prototype, 'sendMessage');
    const authentication = {
      authenticatedPrincipalFor: (request: object) =>
        activeRequests.has(request)
          ? Object.freeze({
              principal: principal(['hosted.query', 'hosted.command']),
              authenticatedSessionId: SESSION_ID,
            })
          : null,
      isHostedQueryAuthorized: (request: object) => Promise.resolve(activeRequests.has(request)),
      isHostedTaskMutationAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      isTeamWorkspaceAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      captureTeamWorkspaceGrantFence: async () =>
        Object.freeze({
          ownerEffectFence: Object.freeze({
            grantRevision: 'b'.repeat(64),
            identityChecksum: 'a'.repeat(64),
          }),
          revalidate: async () => true,
        }),
    };
    app.addHook('onRequest', async (request) => {
      activeRequests.add(request);
    });
    const composition = createHostedTeamMessageComposition({
      authentication,
      runtimeInstance: runtimeInstance(),
      mountBinding: messageMountBinding(),
      teamIdentities: {
        listTeamIdentities: () => Promise.resolve(Object.freeze([activeMessageIdentity()])),
        getTeamIdentity: (teamId) =>
          Promise.resolve(teamId === MESSAGE_TEAM_ID ? activeMessageIdentity() : null),
      },
      expectedDeploymentId: DEPLOYMENT_ID,
    });
    composition.register(app);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_SEND_ROUTE,
        payload: {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: MESSAGE_TEAM_ID,
          clientMessageId: 'client_message_read-only-mount-0001',
          text: 'Do not mutate the externally owned inbox.',
        },
      });
      expect(response.statusCode).toBe(404);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      sendMessage.mockRestore();
      await app.close();
    }
  });

  it('does not advertise message mutation when a supplied source cannot bind the grant fence', async () => {
    const app = Fastify();
    const activeRequests = new WeakSet<object>();
    const authority = messageAuthority();
    const persistMessage = vi.fn(authority.persistMessage);
    const unfencedSource: HostedTeamMessageAuthorityPort = {
      readWindow: authority.readWindow,
      persistMessage,
      deliverPersistedMessage: authority.deliverPersistedMessage,
    };
    const authentication = {
      authenticatedPrincipalFor: (request: object) =>
        activeRequests.has(request)
          ? Object.freeze({
              principal: principal(['hosted.query', 'hosted.command']),
              authenticatedSessionId: SESSION_ID,
            })
          : null,
      isHostedQueryAuthorized: (request: object) => Promise.resolve(activeRequests.has(request)),
      isHostedTaskMutationAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      isTeamWorkspaceAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      captureTeamWorkspaceGrantFence: async () =>
        Object.freeze({
          ownerEffectFence: Object.freeze({
            grantRevision: 'b'.repeat(64),
            identityChecksum: 'a'.repeat(64),
          }),
          revalidate: async () => true,
        }),
    };
    app.addHook('onRequest', async (request) => {
      activeRequests.add(request);
    });
    const composition = createHostedTeamMessageComposition({
      authentication,
      runtimeInstance: runtimeInstance(),
      mountBinding: messageMountBinding(),
      teamIdentities: {} as never,
      expectedDeploymentId: DEPLOYMENT_ID,
      source: unfencedSource,
    });
    composition.register(app);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_SEND_ROUTE,
        payload: {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: MESSAGE_TEAM_ID,
          clientMessageId: 'client_message_unfenced-source-0001',
          text: 'This effect must remain unavailable.',
        },
      });
      expect(response.statusCode).toBe(404);
      expect(persistMessage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses the shared authenticated query context, command grant and redacted HTTP failures', async () => {
    const app = Fastify();
    const activeRequests = new WeakSet<object>();
    const authentication = {
      authenticatedPrincipalFor: (request: object) =>
        activeRequests.has(request)
          ? Object.freeze({
              principal: principal(['hosted.query', 'hosted.command']),
              authenticatedSessionId: SESSION_ID,
            })
          : null,
      isHostedQueryAuthorized: (request: object) => Promise.resolve(activeRequests.has(request)),
      isHostedTaskMutationAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      isTeamWorkspaceAuthorized: (request: object, teamId: typeof MESSAGE_TEAM_ID) =>
        Promise.resolve(activeRequests.has(request) && teamId === MESSAGE_TEAM_ID),
      captureTeamWorkspaceGrantFence: async () =>
        Object.freeze({
          ownerEffectFence: Object.freeze({
            grantRevision: 'b'.repeat(64),
            identityChecksum: 'a'.repeat(64),
          }),
          revalidate: async () => true,
        }),
    };
    app.addHook('onRequest', async (request) => {
      activeRequests.add(request);
    });
    const composition = createHostedTeamMessageComposition({
      authentication,
      runtimeInstance: runtimeInstance(),
      mountBinding: messageMountBinding(),
      teamIdentities: {} as never,
      expectedDeploymentId: DEPLOYMENT_ID,
      source: messageAuthority(),
    });
    composition.register(app);
    await app.ready();
    const pageRequest = {
      schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
      teamId: MESSAGE_TEAM_ID,
      cursor: null,
      expectedSourceGeneration: null,
      limit: 25,
    };
    try {
      const page = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
        payload: pageRequest,
      });
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.json()).toMatchObject({
        kind: 'message_page',
        messages: [{ text: 'Bounded team reply.' }],
      });

      const sent = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_SEND_ROUTE,
        payload: {
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: MESSAGE_TEAM_ID,
          clientMessageId: 'client_message_message-composition-0001',
          text: 'Please review the bounded console.',
        },
      });
      expect(sent.statusCode).toBe(200);
      expect(sent.json()).toMatchObject({
        kind: 'persisted',
        receipt: { runtimeDelivery: 'operator_required' },
      });
    } finally {
      await app.close();
    }

    const deniedApp = Fastify();
    const denied = createHostedTeamMessageComposition({
      authentication: {
        authenticatedPrincipalFor: () => null,
        isHostedQueryAuthorized: () => Promise.resolve(false),
        isHostedTaskMutationAuthorized: () => Promise.resolve(false),
        isTeamWorkspaceAuthorized: () => Promise.resolve(false),
      },
      runtimeInstance: runtimeInstance(),
      mountBinding: messageMountBinding(),
      teamIdentities: {} as never,
      expectedDeploymentId: DEPLOYMENT_ID,
      source: messageAuthority(),
    });
    denied.register(deniedApp);
    await deniedApp.ready();
    try {
      const response = await deniedApp.inject({
        method: 'POST',
        url: HOSTED_TEAM_MESSAGE_PAGE_ROUTE,
        payload: pageRequest,
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(DEPLOYMENT_ID);
      expect(response.body).not.toContain(BOOT_ID);
    } finally {
      await deniedApp.close();
    }
  });
});
