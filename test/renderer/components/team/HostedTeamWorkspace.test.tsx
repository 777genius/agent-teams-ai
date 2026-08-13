import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type ReplayCursor,
} from '@features/coordination-events/contracts';
import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';
import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedClientMessageId,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import {
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
} from '@features/team-task-board/contracts/hosted';
import {
  HOSTED_TASK_BOARD_PAGE_HTTP_PATH,
  type HostedTaskBoardFetchPort,
} from '@features/team-task-board/renderer';
import {
  type HostedTeamCoordinationEventPorts,
  HostedTeamWorkspace,
  type HostedTeamWorkspaceProps,
} from '@renderer/components/team/HostedTeamWorkspace';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  HostedCoordinationEventConnection,
  HostedCoordinationEventTransport,
  HostedCoordinationEventTransportConnectInput,
} from '@features/coordination-events/renderer';
import type { HostedTeamMessageTransport } from '@features/team-message-delivery/renderer';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const TEAM_ID_TWO = parseTeamId(`team_${'c'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const REVISION = parseRevision('revision_hosted-workspace');
const SOURCE_GENERATION = parseHostedTaskBoardSourceGeneration('generation_hosted-workspace');
const MESSAGE_SOURCE_GENERATION = parseHostedMessageSourceGeneration('generation_hosted-messages');
const MESSAGE_ID = parseHostedMessageId(`message_${'d'.repeat(32)}`);
const CLIENT_MESSAGE_ID = parseHostedClientMessageId('client_message_switch-send-0001');
const EXTERNAL_TASK_ID = parseHostedTaskId(`task_${'f'.repeat(32)}`);
const EXTERNAL_MESSAGE_ID = parseHostedMessageId(`message_${'e'.repeat(32)}`);

function replayCursor(value: string): ReplayCursor {
  return value as ReplayCursor;
}

function bootstrapSnapshot(teamId: typeof TEAM_ID, suffix = '0') {
  return Object.freeze({
    metadata: Object.freeze({
      schemaVersion: 1 as const,
      deploymentId: 'deployment-hosted-workspace',
      eventEpoch: 'epoch-hosted-workspace',
      handoffMode: 'lower_barrier' as const,
      replayCursor: replayCursor(`cursor-hosted-workspace-${suffix}`),
      revisionVector: Object.freeze([]),
    }),
    snapshot: Object.freeze({
      schemaVersion: HOSTED_COORDINATION_EVENT_BOOTSTRAP_SCHEMA_VERSION,
      kind: 'team_event_bootstrap' as const,
      teamId,
    }),
  });
}

interface TestCoordinationConnection {
  readonly input: HostedCoordinationEventTransportConnectInput;
  readonly close: ReturnType<typeof vi.fn>;
}

function testCoordinationEvents(input?: {
  readonly loadSnapshot?: HostedTeamCoordinationEventPorts['snapshotResync']['loadSnapshot'];
}): HostedTeamCoordinationEventPorts & {
  readonly connections: TestCoordinationConnection[];
} {
  const connections: TestCoordinationConnection[] = [];
  const transport: HostedCoordinationEventTransport = {
    connect(connectionInput) {
      const close = vi.fn();
      connections.push({
        input: connectionInput as unknown as HostedCoordinationEventTransportConnectInput,
        close,
      });
      const connection: HostedCoordinationEventConnection = {
        cursor: connectionInput.resumeCursor,
        close,
      };
      return connection;
    },
  };
  return Object.freeze({
    connections,
    transport,
    snapshotResync: Object.freeze({
      loadSnapshot:
        input?.loadSnapshot ??
        (async ({ scope }) => bootstrapSnapshot(parseTeamId(scope.scopeId))),
    }),
  });
}

function lifecycleResult(
  teamIds: readonly (typeof TEAM_ID)[] = [TEAM_ID]
): CanonicalListTeamLifecycleResult {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision: REVISION,
    items: Object.freeze(
      teamIds.map((teamId, index) =>
        Object.freeze({
          workspaceId: WORKSPACE_ID,
          teamId,
          displayName: index === 0 ? 'Browser Team' : 'Second Browser Team',
          lifecycle: 'running' as const,
          revision: REVISION,
        })
      )
    ),
    nextCursor: null,
  });
}

function taskBoardPage(teamId = TEAM_ID) {
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    kind: 'task_board_page',
    teamId,
    sourceGeneration: SOURCE_GENERATION,
    revision: REVISION,
    items: Object.freeze([]),
    nextCursor: null,
    truncated: false,
    truncationReasons: Object.freeze([]),
    degraded: Object.freeze({ active: false, reasons: Object.freeze([]) }),
    budget: Object.freeze({
      itemLimit: 25,
      byteLimit: 256 * 1024,
      timeLimitMs: 250,
      usedItems: 0,
      usedBytes: 512,
      elapsedMs: 1,
    }),
  });
}

function taskBoardPageWithSubject(teamId: typeof TEAM_ID, subject: string) {
  const base = taskBoardPage(teamId);
  return Object.freeze({
    ...base,
    items: Object.freeze([
      Object.freeze({
        teamId,
        taskId: EXTERNAL_TASK_ID,
        subject,
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
    budget: Object.freeze({ ...base.budget, usedItems: 1, usedBytes: 640 }),
  });
}

function messagePage(teamId = TEAM_ID) {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    kind: 'message_page' as const,
    teamId,
    sourceGeneration: MESSAGE_SOURCE_GENERATION,
    revision: REVISION,
    messages: Object.freeze([
      Object.freeze({
        teamId,
        messageId: MESSAGE_ID,
        direction: 'team' as const,
        text: 'Ready for your message.',
        createdAtMs: 1,
      }),
    ]),
    nextCursor: null,
  });
}

function messagePageWithText(teamId: typeof TEAM_ID, text: string) {
  return Object.freeze({
    ...messagePage(teamId),
    messages: Object.freeze([
      Object.freeze({
        teamId,
        messageId: EXTERNAL_MESSAGE_ID,
        direction: 'team' as const,
        text,
        createdAtMs: 2,
      }),
    ]),
  });
}

function coordinationEvent(input: {
  readonly teamId?: typeof TEAM_ID;
  readonly sequence: number;
  readonly resource: 'team_task_board' | 'team_messages';
}): HostedCoordinationEventEnvelope {
  const teamId = input.teamId ?? TEAM_ID;
  const isTask = input.resource === 'team_task_board';
  return Object.freeze({
    schemaVersion: 1,
    kind: HOSTED_COORDINATION_EVENT_SSE_EVENT,
    deploymentId: 'deployment-hosted-workspace',
    eventEpoch: 'epoch-hosted-workspace',
    eventSequence: input.sequence,
    eventId: `hosted-workspace-event-${input.sequence}`,
    previousEventCursor: replayCursor(`cursor-hosted-workspace-${input.sequence - 1}`),
    eventCursor: replayCursor(`cursor-hosted-workspace-${input.sequence}`),
    scope: Object.freeze({ kind: 'team' as const, scopeId: teamId }),
    eventType: isTask
      ? 'team.task.external_file_observed'
      : 'team.message.external_inbox_observed',
    emittedAt: '2026-08-13T00:00:00.000Z',
    payload: Object.freeze({ kind: 'invalidate', resource: input.resource }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function emptyMessageTransport(): HostedTeamMessageTransport {
  return {
    getPage: vi.fn(async (request) =>
      Object.freeze({ kind: 'success' as const, page: messagePage(request.teamId) })
    ),
    sendMessage: vi.fn(async (command) =>
      Object.freeze({
        kind: 'persisted' as const,
        receipt: Object.freeze({
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          teamId: command.teamId,
          messageId: MESSAGE_ID,
          clientMessageId: command.clientMessageId,
          persistence: 'durable' as const,
          runtimeDelivery: 'operator_required' as const,
        }),
      })
    ),
  };
}

async function renderWorkspace(
  props: HostedTeamWorkspaceProps
): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HostedTeamWorkspace
        lifecycleTransport={props.lifecycleTransport}
        fetch={props.fetch}
        getCsrfToken={props.getCsrfToken}
        messageFetch={props.messageFetch}
        messageTransport={props.messageTransport}
        messageSendEnabled={props.messageSendEnabled}
        createClientMessageId={props.createClientMessageId}
        coordinationEvents={props.coordinationEvents ?? testCoordinationEvents()}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

function teamButton(host: HTMLElement, name = 'Browser Team'): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(name)
  );
}

// A native click flushes a discrete React update before this deferred-response ordering can occur.
function selectTeamWithoutFlushing(host: HTMLElement, name: string): void {
  const button = teamButton(host, name);
  const propsKey = button
    ? Reflect.ownKeys(button).find(
        (key) => typeof key === 'string' && key.startsWith('__reactProps$')
      )
    : undefined;
  const props =
    propsKey === undefined || button === undefined ? null : Reflect.get(button, propsKey);
  const onClick =
    props !== null && typeof props === 'object' ? Reflect.get(props, 'onClick') : null;
  if (typeof onClick !== 'function') throw new TypeError('hosted-team-selection-handler-missing');
  Reflect.apply(onClick, undefined, []);
}

describe('HostedTeamWorkspace', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('loads the selected branded TeamId through the authenticated task-board HTTP port', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
    };
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockResolvedValue({
      status: 200,
      json: async () => taskBoardPage(),
    });
    const messageTransport = emptyMessageTransport();
    const getCsrfToken = vi.fn(() => 'c'.repeat(32));
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport,
      getCsrfToken,
    });

    expect(host.textContent).toContain('Select a team to view its task board.');
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(messageTransport.getPage).toHaveBeenCalledOnce());

    expect(teamButton(host)?.getAttribute('aria-pressed')).toBe('true');
    expect(fetch.mock.calls[0]?.[0]).toBe(HOSTED_TASK_BOARD_PAGE_HTTP_PATH);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-agent-teams-csrf': 'c'.repeat(32),
      },
    });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body ?? '')).toMatchObject({ teamId: TEAM_ID });
    await vi.waitFor(() => expect(host.textContent).toContain('This team has no tasks.'));
    expect(host.querySelector('[aria-label="Selected team task board"]')?.textContent).toContain(
      'This team has no tasks.'
    );
    expect(host.querySelector('[aria-label="New task title"]')).toBeNull();
    expect(host.textContent).toContain('Ready for your message.');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Refresh task board"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body ?? '')).toMatchObject({ teamId: TEAM_ID });
    expect(getCsrfToken).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it.each([
    ['message-before-task', 'team_messages', 'team_task_board'],
    ['task-before-message', 'team_task_board', 'team_messages'],
  ] as const)(
    'uses one C0 stream and fences in-flight pages for the %s interleaving',
    async (_name, firstResource, secondResource) => {
      const bootstrap = deferred<ReturnType<typeof bootstrapSnapshot>>();
      const staleTaskPage = deferred<Awaited<ReturnType<HostedTaskBoardFetchPort>>>();
      const freshTaskPage = deferred<Awaited<ReturnType<HostedTaskBoardFetchPort>>>();
      const staleMessagePage = deferred<Awaited<ReturnType<HostedTeamMessageTransport['getPage']>>>();
      const freshMessagePage = deferred<Awaited<ReturnType<HostedTeamMessageTransport['getPage']>>>();
      const coordinationEvents = testCoordinationEvents({
        loadSnapshot: vi.fn(() => bootstrap.promise),
      });
      const lifecycleTransport: TeamLifecycleReadTransportApi = {
        listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
      };
      const fetch = vi
        .fn<HostedTaskBoardFetchPort>()
        .mockReturnValueOnce(staleTaskPage.promise)
        .mockReturnValueOnce(freshTaskPage.promise);
      const getPage = vi
        .fn<HostedTeamMessageTransport['getPage']>()
        .mockReturnValueOnce(staleMessagePage.promise)
        .mockReturnValueOnce(freshMessagePage.promise);
      const messageTransport: HostedTeamMessageTransport = {
        getPage,
        sendMessage: vi.fn(async () => ({ kind: 'unavailable' as const })),
      };
      const { host, root } = await renderWorkspace({
        lifecycleTransport,
        fetch,
        messageTransport,
        getCsrfToken: () => 'c'.repeat(32),
        coordinationEvents,
      });

      await act(async () => {
        teamButton(host)?.click();
        await Promise.resolve();
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(getPage).not.toHaveBeenCalled();
      expect(coordinationEvents.connections).toHaveLength(0);

      await act(async () => {
        bootstrap.resolve(bootstrapSnapshot(TEAM_ID));
        await bootstrap.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce());
      expect(coordinationEvents.connections).toHaveLength(1);
      expect(coordinationEvents.connections[0]?.input.resumeCursor).toBe(
        'cursor-hosted-workspace-0'
      );

      await act(async () => {
        expect(
          coordinationEvents.connections[0]?.input.handlers.onEvent(
            coordinationEvent({ sequence: 1, resource: firstResource })
          )
        ).toEqual({ kind: 'advance', resumeCursor: 'cursor-hosted-workspace-1' });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(firstResource === 'team_task_board' ? fetch : getPage).toHaveBeenCalledTimes(2);
      expect(firstResource === 'team_task_board' ? getPage : fetch).toHaveBeenCalledOnce();

      await act(async () => {
        expect(
          coordinationEvents.connections[0]?.input.handlers.onEvent(
            coordinationEvent({ sequence: 2, resource: secondResource })
          )
        ).toEqual({ kind: 'advance', resumeCursor: 'cursor-hosted-workspace-2' });
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(getPage).toHaveBeenCalledTimes(2));

      await act(async () => {
        freshTaskPage.resolve({
          status: 200,
          json: async () => taskBoardPageWithSubject(TEAM_ID, 'Observed external task'),
        });
        freshMessagePage.resolve({
          kind: 'success',
          page: messagePageWithText(TEAM_ID, 'Observed external inbox message'),
        });
        await Promise.all([freshTaskPage.promise, freshMessagePage.promise]);
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(host.textContent).toContain('Observed external task'));
      await vi.waitFor(() =>
        expect(host.textContent).toContain('Observed external inbox message')
      );

      await act(async () => {
        staleTaskPage.resolve({ status: 200, json: async () => taskBoardPage() });
        staleMessagePage.resolve({ kind: 'success', page: messagePage() });
        await Promise.all([staleTaskPage.promise, staleMessagePage.promise]);
        await Promise.resolve();
      });
      expect(host.textContent).toContain('Observed external task');
      expect(host.textContent).toContain('Observed external inbox message');
      expect(coordinationEvents.connections).toHaveLength(1);

      act(() => root.unmount());
      expect(coordinationEvents.connections[0]?.close).toHaveBeenCalledOnce();
    }
  );

  it('deduplicates backfill, resyncs both panels, and tears down streams on team switch', async () => {
    const loadSnapshot = vi
      .fn<HostedTeamCoordinationEventPorts['snapshotResync']['loadSnapshot']>()
      .mockImplementation(async ({ scope }) =>
        bootstrapSnapshot(
          parseTeamId(scope.scopeId),
          scope.scopeId === TEAM_ID ? String(loadSnapshot.mock.calls.length - 1) : '10'
        )
      );
    const coordinationEvents = testCoordinationEvents({ loadSnapshot });
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult([TEAM_ID, TEAM_ID_TWO])),
    };
    const fetch = vi.fn<HostedTaskBoardFetchPort>(async (_path, init) => {
      const request = JSON.parse(init.body) as { teamId: typeof TEAM_ID };
      return { status: 200, json: async () => taskBoardPage(request.teamId) };
    });
    const messageTransport = emptyMessageTransport();
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport,
      getCsrfToken: () => 'c'.repeat(32),
      coordinationEvents,
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(messageTransport.getPage).toHaveBeenCalledOnce());
    expect(coordinationEvents.connections).toHaveLength(1);
    const firstEvent = coordinationEvent({ sequence: 1, resource: 'team_task_board' });
    await act(async () => {
      coordinationEvents.connections[0]?.input.handlers.onEvent(firstEvent);
      coordinationEvents.connections[0]?.input.handlers.onEvent(firstEvent);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      coordinationEvents.connections[0]?.input.handlers.onResyncRequired('cursor_expired');
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(coordinationEvents.connections).toHaveLength(2));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(messageTransport.getPage).toHaveBeenCalledTimes(2));
    expect(coordinationEvents.connections[0]?.close).toHaveBeenCalledOnce();

    await act(async () => {
      teamButton(host, 'Second Browser Team')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(coordinationEvents.connections).toHaveLength(3));
    expect(coordinationEvents.connections[1]?.close).toHaveBeenCalledOnce();
    expect(coordinationEvents.connections[2]?.input.resumeCursor).toBe(
      'cursor-hosted-workspace-10'
    );
    expect(loadSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: { kind: 'team', scopeId: TEAM_ID_TWO } })
    );

    act(() => root.unmount());
    expect(coordinationEvents.connections[2]?.close).toHaveBeenCalledOnce();
  });

  it('enables task mutation controls only after the page advertises writable authority', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
    };
    const response = {
      status: 200,
      headers: {
        get: (name: string) =>
          name === HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement ? 'enabled' : null,
      },
      json: async () => taskBoardPage(),
    };
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockResolvedValue(response);
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport: emptyMessageTransport(),
      getCsrfToken: () => 'm'.repeat(32),
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).not.toBeNull()
    );
    expect(fetch.mock.calls.every(([path]) => path === HOSTED_TASK_BOARD_PAGE_HTTP_PATH)).toBe(
      true
    );
    act(() => root.unmount());
  });

  it('withdraws task mutation controls when a refreshed page no longer advertises writable authority', async () => {
    let advertised = true;
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
    };
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockImplementation(async () => ({
      status: 200,
      headers: {
        get: (name: string) =>
          advertised && name === HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement
            ? 'enabled'
            : null,
      },
      json: async () => taskBoardPage(),
    }));
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport: emptyMessageTransport(),
      getCsrfToken: () => 'r'.repeat(32),
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).not.toBeNull()
    );

    advertised = false;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Refresh task board"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).toBeNull()
    );
    act(() => root.unmount());
  });

  it('ignores an aborted older page advertisement after a newer page omits it', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
    };
    let resolveOlderPage!: (value: {
      status: number;
      headers: { get: (name: string) => string | null };
      json: () => Promise<unknown>;
    }) => void;
    const olderPage = new Promise<{
      status: number;
      headers: { get: (name: string) => string | null };
      json: () => Promise<unknown>;
    }>((resolve) => {
      resolveOlderPage = resolve;
    });
    let pageRequestCount = 0;
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockImplementation(() => {
      pageRequestCount += 1;
      if (pageRequestCount === 1) return olderPage;
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: async () => taskBoardPage(),
      });
    });
    const workspaceProps = {
      lifecycleTransport,
      fetch,
      messageTransport: emptyMessageTransport(),
      getCsrfToken: () => 'p'.repeat(32),
      coordinationEvents: testCoordinationEvents(),
    };
    const { host, root } = await renderWorkspace(workspaceProps);

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const olderSignal = fetch.mock.calls[0]?.[1].signal;

    await act(async () => {
      root.render(<HostedTeamWorkspace {...workspaceProps} getCsrfToken={() => 'p'.repeat(32)} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).toContain('This team has no tasks.'));
    expect(olderSignal?.aborted).toBe(true);

    await act(async () => {
      resolveOlderPage({
        status: 200,
        headers: {
          get: (name: string) =>
            name === HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement ? 'enabled' : null,
        },
        json: async () => taskBoardPage(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('keeps a newly selected team read-only until its own page advertises writable authority', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult([TEAM_ID, TEAM_ID_TWO])),
    };
    type HostedTaskBoardResponse = Awaited<ReturnType<HostedTaskBoardFetchPort>>;
    let resolveTeamAPage!: (response: HostedTaskBoardResponse) => void;
    let resolveTeamBPage!: (response: HostedTaskBoardResponse) => void;
    const teamAPage = new Promise<HostedTaskBoardResponse>((resolve) => {
      resolveTeamAPage = resolve;
    });
    const teamBPage = new Promise<HostedTaskBoardResponse>((resolve) => {
      resolveTeamBPage = resolve;
    });
    const advertisedPage = (teamId: typeof TEAM_ID) => ({
      status: 200,
      headers: {
        get: (name: string) =>
          name === HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement ? 'enabled' : null,
      },
      json: async () => taskBoardPage(teamId),
    });
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockImplementation((_path, init) => {
      const { teamId } = JSON.parse(init.body) as { teamId: typeof TEAM_ID };
      if (teamId === TEAM_ID) return teamAPage;
      expect(teamId).toBe(TEAM_ID_TWO);
      return teamBPage;
    });
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport: emptyMessageTransport(),
      getCsrfToken: () => 's'.repeat(32),
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    await act(async () => {
      selectTeamWithoutFlushing(host, 'Second Browser Team');
      resolveTeamAPage(advertisedPage(TEAM_ID));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body ?? '')).toMatchObject({ teamId: TEAM_ID_TWO });
    expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).toBeNull();

    await act(async () => {
      resolveTeamBPage(advertisedPage(TEAM_ID_TWO));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).not.toBeNull()
    );
    act(() => root.unmount());
  });

  it.each([401, 403, 503, 'throw'] as const)(
    'withdraws task mutation controls after a %s mutation failure and allows a later advertised page refresh',
    async (mutationFailure) => {
      let advertised = true;
      const lifecycleTransport: TeamLifecycleReadTransportApi = {
        listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
      };
      const fetch = vi.fn<HostedTaskBoardFetchPort>().mockImplementation(async (path) => {
        if (path === HOSTED_TASK_BOARD_PAGE_HTTP_PATH) {
          return {
            status: 200,
            headers: {
              get: (name: string) =>
                advertised && name === HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement
                  ? 'enabled'
                  : null,
            },
            json: async () => taskBoardPage(),
          };
        }
        expect(path).toBe(HOSTED_TASK_BOARD_MUTATION_ROUTE);
        if (mutationFailure === 'throw') throw new Error('mutation transport failed');
        return {
          status: mutationFailure,
          json: async () => ({
            schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
            kind: 'error',
            error: { code: 'unavailable', reason: 'task_board_unavailable' },
            retryable: true,
          }),
        };
      });
      const { host, root } = await renderWorkspace({
        lifecycleTransport,
        fetch,
        messageTransport: emptyMessageTransport(),
        getCsrfToken: () => 'u'.repeat(32),
      });

      await act(async () => {
        teamButton(host)?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).not.toBeNull()
      );

      advertised = false;
      const title = host.querySelector<HTMLInputElement>('[aria-label="New task title"]');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      await act(async () => {
        setValue?.call(title, 'Withdraw unsafe authority');
        title?.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {
        Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
          .find((button) => button.textContent === 'Save task')
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() =>
        expect(fetch.mock.calls.some(([path]) => path === HOSTED_TASK_BOARD_MUTATION_ROUTE)).toBe(
          true
        )
      );
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).toBeNull()
      );
      await vi.waitFor(() => expect(host.textContent).toContain('This team has no tasks.'));

      advertised = true;
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-label="Refresh task board"]')?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).not.toBeNull()
      );
      act(() => root.unmount());
    }
  );

  it('shows only safe unavailable copy when the injected task-board fetch fails', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
    };
    const privateFailure = '/private/workspaces/browser-team/tasks.json is unreadable';
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockRejectedValue(new Error(privateFailure));
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport: emptyMessageTransport(),
      getCsrfToken: () => 'd'.repeat(32),
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        'The task board is temporarily unavailable. Refresh to try again.'
      )
    );
    expect(host.textContent).toContain(
      'The task board is temporarily unavailable. Refresh to try again.'
    );
    expect(host.textContent).not.toContain(privateFailure);
    expect(host.innerHTML).not.toContain('/private/workspaces');
    expect(host.querySelector('[aria-label="New task title"]')).toBeNull();
    act(() => root.unmount());
  });

  it('does not enable task mutation controls from an advertisement on an error response', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
    };
    const response = {
      status: 503,
      headers: {
        get: (name: string) =>
          name === HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement ? 'enabled' : null,
      },
      json: async () => ({
        schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
        kind: 'error',
        error: { code: 'unavailable', reason: 'task_board_unavailable' },
        retryable: true,
      }),
    };
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockResolvedValue(response);
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport: emptyMessageTransport(),
      getCsrfToken: () => 'f'.repeat(32),
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.querySelector('[aria-label="New task title"]')).toBeNull();
    act(() => root.unmount());
  });

  it('switches the task board and bounded message panel together, then sends through the message port', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult([TEAM_ID, TEAM_ID_TWO])),
    };
    const fetch = vi.fn<HostedTaskBoardFetchPort>(async (_path, init) => {
      const request = JSON.parse(init.body) as { teamId: typeof TEAM_ID };
      return { status: 200, json: async () => taskBoardPage(request.teamId) };
    });
    const messageTransport = emptyMessageTransport();
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
      messageTransport,
      messageSendEnabled: true,
      createClientMessageId: () => CLIENT_MESSAGE_ID,
      getCsrfToken: () => 'e'.repeat(32),
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(messageTransport.getPage).toHaveBeenCalledOnce());
    expect(messageTransport.getPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ teamId: TEAM_ID }),
      expect.anything()
    );

    await act(async () => {
      teamButton(host, 'Second Browser Team')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(messageTransport.getPage).toHaveBeenCalledTimes(2));
    expect(messageTransport.getPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ teamId: TEAM_ID_TWO }),
      expect.anything()
    );
    expect(JSON.parse(fetch.mock.calls.at(-1)?.[1].body ?? '')).toMatchObject({
      teamId: TEAM_ID_TWO,
    });

    const draft = host.querySelector<HTMLTextAreaElement>('textarea');
    expect(draft).not.toBeNull();
    await act(async () => {
      const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      value?.call(draft, 'Please review the current team state.');
      draft?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Send')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(messageTransport.sendMessage).toHaveBeenCalledOnce());
    expect(messageTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM_ID_TWO,
        clientMessageId: CLIENT_MESSAGE_ID,
        text: 'Please review the current team state.',
      }),
      expect.anything()
    );
    expect(host.textContent).toContain(
      'Your message was saved. Delivery needs an operator check and will not be resent automatically.'
    );
    act(() => root.unmount());
  });

  it('keeps CSRF failures inside the bounded message transport and redacts them in the panel', async () => {
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn().mockResolvedValue(lifecycleResult()),
    };
    const messageFetch = vi.fn();
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch: vi.fn<HostedTaskBoardFetchPort>(),
      messageFetch,
      getCsrfToken: () => null,
    });

    await act(async () => {
      teamButton(host)?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Messages'));
    expect(messageFetch).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="New message"]')).toBeNull();
    expect(
      Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Send')
    ).toBe(false);
    expect(host.innerHTML).not.toContain('csrf');
    act(() => root.unmount());
  });
});
