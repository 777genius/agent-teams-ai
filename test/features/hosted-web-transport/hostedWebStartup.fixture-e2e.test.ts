import {
  type HostedWebCreateTaskRequest,
  hostedWebErrorCode,
  type HostedWebEvent,
  type HostedWebLaunchTeamRequest,
  type HostedWebTeamSnapshotResponse,
  type HostedWebTeamSummary,
} from '@features/hosted-web-transport/contracts';
import {
  createHostedWebTransportClient,
  type HostedWebEventSourceConstructor,
  type HostedWebFetch,
  type HostedWebSocketConstructor,
} from '@features/hosted-web-transport/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<string, EventListener>();
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: HostedWebEvent, lastEventId = event.eventId): void {
    this.listeners.get(event.type)?.({
      type: event.type,
      data: JSON.stringify(event),
      lastEventId,
    } as MessageEvent<string>);
  }
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly protocols?: string | string[];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }
}

describe('hosted web startup fixture fastgate', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    MockWebSocket.instances = [];
  });

  it('starts the hosted workflow through a browser-safe transport and sandbox facade only', async () => {
    const fixture = createSandboxHostedFixture();
    const onEvent = vi.fn();
    const client = createHostedWebTransportClient({
      baseUrl: 'https://hosted.example',
      fetch: fixture.createBrowserSessionFetch(),
      EventSource: MockEventSource as unknown as HostedWebEventSourceConstructor,
      WebSocket: MockWebSocket as unknown as HostedWebSocketConstructor,
    });

    const subscription = client.subscribeToTeamEvents({ teamId: 'sandbox-team' }, { onEvent });
    await expect(
      client.launchTeam('sandbox-team', {
        workspaceRef: {
          id: 'sandbox://fixtures/hosted-web-fastgate',
          displayName: 'Hosted Web Fastgate Sandbox',
          repositoryLabel: 'synthetic-fixture',
          branchLabel: 'fixture',
        },
        provider: { providerId: 'codex', modelId: 'fake-browser-safe-model' },
        members: [{ displayName: 'Synthetic Lead', role: 'lead' }],
        prompt: 'Synthetic startup only; do not launch agents.',
      })
    ).resolves.toEqual({ runId: 'run-sandbox-team-1', launchStatus: 'started' });
    await expect(
      client.createTask('sandbox-team', {
        subject: 'Exercise hosted web facade',
        description: 'Synthetic task stored in the fake facade.',
        startImmediately: false,
      })
    ).resolves.toMatchObject({ task: { taskId: 'task-1', status: 'pending' } });
    const terminalSession = await client.createTerminalSession('sandbox-team', {
      preferredMemberId: 'lead',
      cols: 120,
      rows: 30,
    });
    expect(terminalSession).toMatchObject({
      terminalSessionId: 'terminal-sandbox-team-1',
      webSocketUrl: 'wss://hosted.example/api/hosted/v1/terminal/terminal-sandbox-team-1',
    });
    client.openTerminalStream({
      webSocketUrl: terminalSession.webSocketUrl,
      protocols: 'agent-teams-terminal.v1',
    });

    const snapshot = await client.getTeamSnapshot('sandbox-team');
    expect(JSON.stringify(snapshot)).toContain('sandbox://fixtures/hosted-web-fastgate');
    expect(JSON.stringify(snapshot)).not.toContain('/Users/');
    expect(JSON.stringify(snapshot)).not.toContain('"cwd"');
    expect(fixture.facadeStartupRequests).toHaveLength(1);
    expect(fixture.agentLaunchAttempts).toBe(0);
    expect(fixture.realProjectTouches).toEqual([]);
    expect(MockEventSource.instances[0]?.url).toBe(
      'https://hosted.example/api/hosted/v1/events?teamId=sandbox-team'
    );
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]).toMatchObject({
      url: 'wss://hosted.example/api/hosted/v1/terminal/terminal-sandbox-team-1',
      protocols: 'agent-teams-terminal.v1',
    });

    MockEventSource.instances[0]?.emit(fixture.createProviderAuthErrorEvent('sandbox-team'));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'hosted.error',
        payload: expect.objectContaining({
          code: '/api/hosted/v1/errors/provider_auth_required',
        }),
      })
    );
    expect(subscription.getLastEventId()).toBe('event-auth-error-sandbox-team');
    subscription.close();
    expect(MockEventSource.instances[0]?.closed).toBe(true);
  });

  it('rejects missing auth before the app facade can start anything', async () => {
    const fixture = createSandboxHostedFixture();
    const client = createHostedWebTransportClient({
      baseUrl: 'https://hosted.example',
      fetch: fixture.fetch,
    });

    await expect(client.listTeams()).rejects.toMatchObject({
      kind: 'http',
      status: 401,
      code: '/api/hosted/v1/errors/auth_required',
    });
    expect(fixture.facadeStartupRequests).toEqual([]);
    expect(fixture.agentLaunchAttempts).toBe(0);
    expect(fixture.realProjectTouches).toEqual([]);
  });

  it('rejects non-sandbox workspace refs without launching a runtime', async () => {
    const fixture = createSandboxHostedFixture();
    const client = createHostedWebTransportClient({
      baseUrl: 'https://hosted.example',
      fetch: fixture.createBrowserSessionFetch(),
    });

    await expect(
      client.launchTeam('real-project', {
        workspaceRef: {
          id: '/Users/example/real-project',
          displayName: 'Real Project',
        },
      })
    ).rejects.toMatchObject({
      kind: 'http',
      status: 403,
      code: '/api/hosted/v1/errors/sandbox_only',
    });
    expect(fixture.facadeStartupRequests).toEqual([]);
    expect(fixture.agentLaunchAttempts).toBe(0);
    expect(fixture.realProjectTouches).toEqual(['/Users/example/real-project']);
  });

  it('rejects unavailable provider auth before launching a runtime', async () => {
    const fixture = createSandboxHostedFixture();
    const client = createHostedWebTransportClient({
      baseUrl: 'https://hosted.example',
      fetch: fixture.createBrowserSessionFetch(),
    });

    await expect(
      client.launchTeam('provider-auth-required', {
        workspaceRef: {
          id: 'sandbox://fixtures/hosted-web-fastgate',
          displayName: 'Hosted Web Fastgate Sandbox',
        },
        provider: { providerId: 'anthropic', modelId: 'requires-real-provider-auth' },
      })
    ).rejects.toMatchObject({
      kind: 'http',
      status: 401,
      code: '/api/hosted/v1/errors/provider_auth_required',
    });
    expect(fixture.facadeStartupRequests).toEqual([]);
    expect(fixture.agentLaunchAttempts).toBe(0);
    expect(fixture.realProjectTouches).toEqual([]);
  });
});

interface SandboxHostedFixture {
  readonly facadeStartupRequests: HostedWebLaunchTeamRequest[];
  readonly realProjectTouches: string[];
  readonly fetch: HostedWebFetch;
  get agentLaunchAttempts(): number;
  createBrowserSessionFetch(): HostedWebFetch;
  createProviderAuthErrorEvent(teamId: string): HostedWebEvent;
}

function createSandboxHostedFixture(): SandboxHostedFixture {
  const sessionHeaderName = 'x-fixture-hosted-web-session';
  const sessionHeaderValue = 'sandbox-session';
  const facadeStartupRequests: HostedWebLaunchTeamRequest[] = [];
  const realProjectTouches: string[] = [];
  const teams = new Map<string, HostedWebTeamSnapshotResponse>();
  const runtime = createFakeHostedRuntime();

  const fetch: HostedWebFetch = async (input, init) => {
    if (init?.headers?.[sessionHeaderName] !== sessionHeaderValue) {
      return jsonResponse(
        {
          error: {
            code: hostedWebErrorCode('auth_required'),
            message: 'Hosted web auth is required for synthetic startup.',
          },
        },
        false,
        401
      );
    }

    const url = new URL(input, 'https://hosted.example');
    if (url.pathname === '/api/hosted/v1/teams') {
      return jsonResponse({ teams: [...teams.values()].map((snapshot) => snapshot.team) });
    }

    const teamMatch = url.pathname.match(
      /^\/api\/hosted\/v1\/teams\/([^/]+)(?:\/(launch|tasks|terminal\/sessions))?$/u
    );
    if (!teamMatch) {
      return notFound();
    }

    const teamId = decodeURIComponent(teamMatch[1] ?? '');
    const action = teamMatch[2] ?? 'snapshot';
    if (action === 'launch') {
      const request = parseBody<HostedWebLaunchTeamRequest>(init?.body);
      if (!request.workspaceRef.id.startsWith('sandbox://')) {
        realProjectTouches.push(request.workspaceRef.id);
        return jsonResponse(
          {
            error: {
              code: hostedWebErrorCode('sandbox_only'),
              message: 'Hosted web fastgate accepts sandbox workspace refs only.',
            },
          },
          false,
          403
        );
      }
      if (request.provider?.providerId === 'anthropic') {
        return jsonResponse(
          {
            error: {
              code: hostedWebErrorCode('provider_auth_required'),
              message: 'Synthetic provider auth is unavailable in the hosted web fastgate.',
            },
          },
          false,
          401
        );
      }

      facadeStartupRequests.push(request);
      teams.set(teamId, createSnapshot(teamId, request));
      return jsonResponse({ runId: `run-${teamId}-1`, launchStatus: 'started' });
    }

    const snapshot = teams.get(teamId);
    if (!snapshot) {
      return notFound();
    }

    if (action === 'tasks') {
      const request = parseBody<HostedWebCreateTaskRequest>(init?.body);
      const task = {
        taskId: `task-${snapshot.tasks.length + 1}`,
        subject: request.subject,
        description: request.description,
        status: 'pending' as const,
        ownerMemberId: request.ownerMemberId,
      };
      snapshot.tasks.push(task);
      snapshot.kanban = [{ status: 'pending', taskIds: snapshot.tasks.map((item) => item.taskId) }];
      snapshot.team.taskCount = snapshot.tasks.length;
      return jsonResponse({ task });
    }

    if (action === 'terminal/sessions') {
      return jsonResponse({
        terminalSessionId: `terminal-${teamId}-1`,
        webSocketUrl: `wss://hosted.example/api/hosted/v1/terminal/terminal-${teamId}-1`,
        expiresAt: '2026-07-11T01:00:00.000Z',
      });
    }

    return jsonResponse(snapshot);
  };

  return {
    facadeStartupRequests,
    realProjectTouches,
    fetch,
    get agentLaunchAttempts() {
      return runtime.agentLaunchAttempts;
    },
    createBrowserSessionFetch() {
      return (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            [sessionHeaderName]: sessionHeaderValue,
          },
        });
    },
    createProviderAuthErrorEvent(teamId) {
      return {
        type: 'hosted.error',
        eventId: `event-auth-error-${teamId}`,
        teamId,
        emittedAt: '2026-07-11T00:00:00.000Z',
        payload: {
          code: hostedWebErrorCode('provider_auth_required'),
          message: 'Fake runtime reports provider auth missing.',
          retryable: false,
        },
      };
    },
  };

  function createSnapshot(
    teamId: string,
    request: HostedWebLaunchTeamRequest
  ): HostedWebTeamSnapshotResponse {
    const team: HostedWebTeamSummary = {
      teamId,
      displayName: teamId,
      description: 'Synthetic hosted web fixture team',
      project: { workspaceRef: request.workspaceRef },
      members: [
        {
          memberId: 'lead',
          displayName: request.members?.[0]?.displayName ?? 'Synthetic Lead',
          role: request.members?.[0]?.role,
          provider: request.provider,
          currentTaskId: null,
          taskCount: 0,
          isolation: 'managed-worktree',
        },
      ],
      taskCount: 0,
      lastActivity: '2026-07-11T00:00:00.000Z',
      runtime: {
        isAlive: false,
        terminalAvailable: true,
        activeProcessCount: runtime.agentLaunchAttempts,
      },
    };
    return { team, tasks: [], kanban: [{ status: 'pending', taskIds: [] }], revision: 'rev-1' };
  }
}

function createFakeHostedRuntime(): { agentLaunchAttempts: number } {
  return {
    agentLaunchAttempts: 0,
  };
}

function parseBody<T>(body: string | undefined): T {
  return JSON.parse(body ?? '{}') as T;
}

function notFound(): ReturnType<HostedWebFetch> {
  return jsonResponse(
    {
      error: {
        code: hostedWebErrorCode('not_found'),
        message: 'Synthetic hosted web route was not found.',
      },
    },
    false,
    404
  );
}

function jsonResponse(payload: unknown, ok = true, status = 200): ReturnType<HostedWebFetch> {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}
