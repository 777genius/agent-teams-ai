import {
  createHostedWorkspaceProjectionScope,
  parseHostedWorkspaceId,
  projectHostedPayload,
} from '@features/hosted-access';
import { createHostedCoordinationEventStreamAuthorizer } from '@main/composition/hosted/hostedCoordinationEventStreamAuthorizer';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  CoordinationEventEnvelope,
  CoordinationJsonValue,
} from '@features/coordination-events/contracts';
import type { HostedAuthHttpFacade } from '@features/hosted-access/main';
import type { TeamId } from '@shared/contracts/hosted';

const RUNTIME_WORKSPACE_ID = 'runtime-workspace-private';
const PUBLIC_WORKSPACE_ID = parseHostedWorkspaceId('workspace_11111111111111111111111111111111');
const TEAM_ID = parseTeamId('team_11111111111111111111111111111111');
const OTHER_TEAM_ID = parseTeamId('team_22222222222222222222222222222222');

type HostedCoordinationEventAuth = HostedAuthHttpFacade & {
  isTeamWorkspaceEventAuthorized(
    request: unknown,
    teamId: TeamId,
    runtimeWorkspaceId: string
  ): Promise<boolean>;
};

function event(overrides: Partial<CoordinationEventEnvelope> = {}): CoordinationEventEnvelope {
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-private',
    eventEpoch: 'epoch-private',
    eventSequence: 1,
    eventId: 'event-1',
    eventCursor: 'cursor-1' as never,
    workspaceId: RUNTIME_WORKSPACE_ID,
    teamId: 'team-private',
    runId: 'run-private',
    scope: { kind: 'team', scopeId: 'team-private' },
    actor: { kind: 'operator', actorRef: 'actor-private' },
    eventType: 'team-lifecycle.lane-status-observed',
    resourceRevision: { resourceKey: 'team-private', generation: 1, revision: 2 },
    emittedAt: '2026-08-02T00:00:00.000Z',
    payload: { generation: 1, state: 'ready' },
    ...overrides,
  };
}

function auth(
  overrides: Partial<HostedCoordinationEventAuth> = {}
): HostedCoordinationEventAuth {
  return {
    allowedOrigin: 'https://host.test',
    register: vi.fn(),
    isWorkspaceRegistered: vi.fn(async () => true),
    projectWorkspaceId: vi.fn(async () => null),
    projectPayload: vi.fn(async () => null),
    isEventStreamAuthorized: vi.fn(async () => true),
    isTeamWorkspaceEventAuthorized: vi.fn(async () => true),
    projectEvent: vi.fn(async (_request, _channel, data) => {
      const source = data as {
        readonly scope: unknown;
        readonly eventType: string;
        readonly resourceRevision?: unknown;
        readonly payload: unknown;
      };
      return {
        workspaceId: PUBLIC_WORKSPACE_ID,
        scope: source.scope,
        eventType: source.eventType,
        resourceRevision: source.resourceRevision,
        payload: source.payload,
      };
    }),
    ...overrides,
  };
}

function externalEvent(
  eventType:
    | 'team.task.external_file_observed'
    | 'team.message.external_inbox_observed',
  overrides: Partial<CoordinationEventEnvelope> = {}
): CoordinationEventEnvelope {
  const task = eventType === 'team.task.external_file_observed';
  return event({
    teamId: TEAM_ID,
    scope: { kind: 'team', scopeId: TEAM_ID },
    eventType,
    resourceRevision: {
      resourceKey: task ? 'task:provider-write' : 'inbox:user',
      generation: 1,
      revision: 2,
    },
    payload: {
      actorKind: 'external_file',
      contentChecksum: 'a'.repeat(64),
      effect: 'observed',
      fileKey: task ? 'provider-write.json' : 'user.json',
      reconciliationId: task ? 'reconciliation-task' : 'reconciliation-inbox',
      ...(task ? { taskId: 'provider-write' } : { inboxId: 'user', messageCount: 1 }),
    },
    ...overrides,
  });
}

function realGenericProjector() {
  const projectionScope = createHostedWorkspaceProjectionScope(
    [{ workspaceId: PUBLIC_WORKSPACE_ID, runtimeWorkspaceId: RUNTIME_WORKSPACE_ID }],
    [{ workspaceId: PUBLIC_WORKSPACE_ID, runtimeWorkspaceId: RUNTIME_WORKSPACE_ID }]
  );
  const projectEvent = vi.fn(async (_request: unknown, _channel: string, data: unknown) =>
    projectHostedPayload(data, projectionScope)
  );
  return { projectionScope, projectEvent, hostedAuth: auth({ projectEvent }) };
}

const NEUTRAL_SENTINEL_A = ['member', 'hidden', 'field', 'a'].join('-');
const NEUTRAL_SENTINEL_B = ['member', 'hidden', 'field', 'b'].join('-');
const NEUTRAL_SENTINEL_C = ['member', 'hidden', 'field', 'c'].join('-');
const NEUTRAL_SENTINEL_D = ['member', 'hidden', 'field', 'd'].join('-');

const LEAK_FIXTURES: readonly {
  readonly name: string;
  readonly leakedPayload: CoordinationJsonValue;
  readonly leakedNames: readonly string[];
}[] = [
  {
    name: 'raw provider and command fields',
    leakedPayload: {
      generation: 1,
      state: 'ready',
      providerBackendId: 'backend-private',
      provider: 'provider-private',
      token: NEUTRAL_SENTINEL_A,
      secret: NEUTRAL_SENTINEL_B,
      commandBody: 'command-private',
    },
    leakedNames: ['providerBackendId', 'provider', 'token', 'secret', 'commandBody'],
  },
  {
    name: 'nested aliases',
    leakedPayload: {
      generation: 1,
      state: 'ready',
      metadata: {
        provider: { providerBackendId: 'nested-backend-private' },
        credentials: { token: NEUTRAL_SENTINEL_C, secret: NEUTRAL_SENTINEL_D },
        request: { commandBody: 'nested-command-private' },
      },
    },
    leakedNames: ['providerBackendId', 'provider', 'token', 'secret', 'commandBody'],
  },
];

describe('hosted coordination event stream authorizer', () => {
  it('binds the configured origin and requires a live stream session', async () => {
    const hostedAuth = auth({ isEventStreamAuthorized: vi.fn(async () => false) });
    const authorizer = createHostedCoordinationEventStreamAuthorizer(hostedAuth);

    expect(authorizer.allowedOrigin).toBe('https://host.test');
    await expect(authorizer.authorize({} as never)).resolves.toBeNull();
    expect(hostedAuth.projectEvent).not.toHaveBeenCalled();
  });

  it('exposes a fail-closed live authorization check for an admitted stream', async () => {
    const live = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const hostedAuth = auth({ isEventStreamAuthorized: live });
    const authorization = await createHostedCoordinationEventStreamAuthorizer(hostedAuth).authorize(
      {} as never
    );

    await expect(authorization!.isCurrent()).resolves.toBe(false);
    expect(live).toHaveBeenCalledTimes(2);

    live.mockRejectedValueOnce(new Error('authorization-storage-unavailable'));
    await expect(authorization!.isCurrent()).resolves.toBe(false);
  });

  it('passes only the workspace projection allowlist and emits a closed invalidation DTO', async () => {
    const hostedAuth = auth();
    const request = {} as never;
    const authorization =
      await createHostedCoordinationEventStreamAuthorizer(hostedAuth).authorize(request);
    const projected = await authorization!.projectEvent(event());

    expect(hostedAuth.projectEvent).toHaveBeenCalledWith(request, 'coordination_event', {
      workspaceId: RUNTIME_WORKSPACE_ID,
      scope: { kind: 'team', scopeId: 'team-private' },
      eventType: 'team-lifecycle.lane-status-observed',
      resourceRevision: { resourceKey: 'team-private', generation: 1, revision: 2 },
      payload: { generation: 1, state: 'ready' },
    });
    const allowlisted = vi.mocked(hostedAuth.projectEvent).mock.calls[0]?.[2] as object;
    expect(allowlisted).not.toHaveProperty('actor');
    expect(allowlisted).not.toHaveProperty('actorId');
    expect(allowlisted).not.toHaveProperty('teamId');
    expect(allowlisted).not.toHaveProperty('runId');
    expect(projected).toEqual({
      scope: { kind: 'workspace', scopeId: PUBLIC_WORKSPACE_ID },
      eventType: 'team-lifecycle.lane-status-observed',
      publicPayload: { kind: 'invalidate', resource: 'team_lifecycle' },
    });
    expect(Object.getPrototypeOf(projected!.publicPayload)).toBe(Object.prototype);
  });

  it('allows the known run-accepted shape without exposing its private fields', async () => {
    const real = realGenericProjector();
    const authorization = await createHostedCoordinationEventStreamAuthorizer(
      real.hostedAuth
    ).authorize({} as never);
    const projected = await authorization!.projectEvent(
      event({
        eventType: 'team-lifecycle.run-accepted',
        payload: {
          fileWriterEpoch: 3,
          generation: 4,
          planHash: 'plan-private',
          runId: 'run-private',
          watcherWatermark: 5,
        },
      })
    );

    expect(real.projectEvent).toHaveBeenCalledOnce();
    expect(projected).toEqual({
      scope: { kind: 'workspace', scopeId: PUBLIC_WORKSPACE_ID },
      eventType: 'team-lifecycle.run-accepted',
      publicPayload: { kind: 'invalidate', resource: 'team_lifecycle' },
    });
    expect(JSON.stringify(projected)).not.toMatch(/plan-private|run-private/u);
  });

  it.each([
    {
      eventType: 'team.task.external_file_observed' as const,
      resource: 'team_task_board',
    },
    {
      eventType: 'team.message.external_inbox_observed' as const,
      resource: 'team_messages',
    },
  ])('projects $eventType as a team-authorized closed invalidation', async (fixture) => {
    const real = realGenericProjector();
    const teamAuthorized = vi.fn(async () => true);
    const hostedAuth = { ...real.hostedAuth, isTeamWorkspaceEventAuthorized: teamAuthorized };
    const request = {} as never;
    const authorization = await createHostedCoordinationEventStreamAuthorizer(
      hostedAuth
    ).authorize(request);
    const projected = await authorization!.projectEvent(externalEvent(fixture.eventType));

    expect(teamAuthorized).toHaveBeenNthCalledWith(1, request, TEAM_ID, RUNTIME_WORKSPACE_ID);
    expect(teamAuthorized).toHaveBeenNthCalledWith(2, request, TEAM_ID, RUNTIME_WORKSPACE_ID);
    expect(real.projectEvent).toHaveBeenCalledWith(request, 'coordination_event', {
      workspaceId: RUNTIME_WORKSPACE_ID,
      scope: { kind: 'team', scopeId: TEAM_ID },
      eventType: fixture.eventType,
      payload: { kind: 'invalidate', resource: fixture.resource },
    });
    expect(projected).toEqual({
      scope: { kind: 'team', scopeId: TEAM_ID },
      eventType: fixture.eventType,
      publicPayload: { kind: 'invalidate', resource: fixture.resource },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /provider-write|user\.json|reconciliation|contentChecksum|fileKey/u
    );
  });

  it('denies external events outside the exact team grant and scope binding', async () => {
    const projectEvent = vi.fn();
    const isTeamWorkspaceEventAuthorized = vi.fn(
      async (_request: unknown, teamId: TeamId, runtimeWorkspaceId: string) =>
        teamId === TEAM_ID && runtimeWorkspaceId === RUNTIME_WORKSPACE_ID
    );
    const authorization = await createHostedCoordinationEventStreamAuthorizer(
      auth({ projectEvent, isTeamWorkspaceEventAuthorized })
    ).authorize({} as never);

    await expect(
      authorization!.projectEvent(
        externalEvent('team.task.external_file_observed', {
          teamId: OTHER_TEAM_ID,
          scope: { kind: 'team', scopeId: OTHER_TEAM_ID },
        })
      )
    ).resolves.toBeNull();
    await expect(
      authorization!.projectEvent(
        externalEvent('team.message.external_inbox_observed', {
          scope: { kind: 'team', scopeId: OTHER_TEAM_ID },
        })
      )
    ).resolves.toBeNull();
    await expect(
      authorization!.projectEvent(
        externalEvent('team.task.external_file_observed', {
          workspaceId: 'other-granted-runtime-workspace',
        })
      )
    ).resolves.toBeNull();
    expect(projectEvent).not.toHaveBeenCalled();
  });

  it('default-denies expanded external payloads before workspace projection', async () => {
    const hostedAuth = auth();
    const authorization = await createHostedCoordinationEventStreamAuthorizer(hostedAuth).authorize(
      {} as never
    );
    const source = externalEvent('team.task.external_file_observed');

    await expect(
      authorization!.projectEvent(
        externalEvent('team.task.external_file_observed', {
          payload: { ...(source.payload as object), secret: NEUTRAL_SENTINEL_A },
        })
      )
    ).resolves.toBeNull();
    expect(hostedAuth.projectEvent).not.toHaveBeenCalled();
  });

  it('denies an external event when its exact team/workspace grant changes during projection', async () => {
    const real = realGenericProjector();
    const exactAuthorization = vi
      .fn<HostedCoordinationEventAuth['isTeamWorkspaceEventAuthorized']>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const hostedAuth = {
      ...real.hostedAuth,
      isTeamWorkspaceEventAuthorized: exactAuthorization,
    };
    const authorization = await createHostedCoordinationEventStreamAuthorizer(hostedAuth).authorize(
      {} as never
    );

    await expect(
      authorization!.projectEvent(externalEvent('team.task.external_file_observed'))
    ).resolves.toBeNull();
    expect(exactAuthorization).toHaveBeenCalledTimes(2);
    expect(hostedAuth.projectEvent).toHaveBeenCalledOnce();
  });

  it.each(LEAK_FIXTURES)(
    'denies $name that survive the real generic hosted projector',
    async (fixture) => {
      const real = realGenericProjector();
      const rawProjected = projectHostedPayload(
        {
          workspaceId: RUNTIME_WORKSPACE_ID,
          scope: { kind: 'team', scopeId: 'team-private' },
          eventType: 'team-lifecycle.lane-status-observed',
          payload: fixture.leakedPayload,
        },
        real.projectionScope
      );
      const rawJson = JSON.stringify(rawProjected);
      for (const leakedName of fixture.leakedNames) expect(rawJson).toContain(leakedName);

      const authorization = await createHostedCoordinationEventStreamAuthorizer(
        real.hostedAuth
      ).authorize({} as never);
      await expect(
        authorization!.projectEvent(event({ payload: fixture.leakedPayload }))
      ).resolves.toBeNull();
      expect(real.projectEvent).toHaveBeenCalledOnce();
    }
  );

  it('revalidates each event and closes projection on a revoked grant', async () => {
    const project = vi
      .fn()
      .mockResolvedValueOnce({
        workspaceId: PUBLIC_WORKSPACE_ID,
        scope: { kind: 'team', scopeId: 'team-private' },
        eventType: 'team-lifecycle.lane-status-observed',
        resourceRevision: { resourceKey: 'team-private', generation: 1, revision: 2 },
        payload: { generation: 1, state: 'ready' },
      })
      .mockResolvedValueOnce(null);
    const authorization = await createHostedCoordinationEventStreamAuthorizer(
      auth({ projectEvent: project })
    ).authorize({} as never);

    await expect(authorization!.projectEvent(event())).resolves.toMatchObject({
      scope: { scopeId: PUBLIC_WORKSPACE_ID },
    });
    await expect(authorization!.projectEvent(event({ eventSequence: 2 }))).resolves.toBeNull();
    expect(project).toHaveBeenCalledTimes(2);
  });

  it('hides private-scope, unattributed, malformed, unknown, and expanded events', async () => {
    const hostedAuth = auth();
    const authorization = await createHostedCoordinationEventStreamAuthorizer(hostedAuth).authorize(
      {} as never
    );

    await expect(
      authorization!.projectEvent(event({ scope: { kind: 'instance', scopeId: 'instance-1' } }))
    ).resolves.toBeNull();
    await expect(
      authorization!.projectEvent(event({ workspaceId: undefined }))
    ).resolves.toBeNull();
    await expect(
      authorization!.projectEvent(event({ eventType: 'bad\nevent' }))
    ).resolves.toBeNull();
    await expect(
      authorization!.projectEvent(event({ eventType: 'workspace.changed' }))
    ).resolves.toBeNull();
    await expect(
      authorization!.projectEvent(
        event({ payload: { generation: 1, state: 'ready', extra: 'default-deny' } })
      )
    ).resolves.toBeNull();
  });

  it('fails closed when live auth or projection storage is unavailable', async () => {
    const unavailable = auth({
      isEventStreamAuthorized: vi.fn(async () => {
        throw new Error('storage-unavailable');
      }),
    });
    await expect(
      createHostedCoordinationEventStreamAuthorizer(unavailable).authorize({} as never)
    ).resolves.toBeNull();

    const authorization = await createHostedCoordinationEventStreamAuthorizer(
      auth({
        projectEvent: vi.fn(async () => {
          throw new Error('storage-unavailable');
        }),
      })
    ).authorize({} as never);
    await expect(authorization!.projectEvent(event())).resolves.toBeNull();
  });
});
