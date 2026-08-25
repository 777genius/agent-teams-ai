import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
} from '@features/team-task-board/contracts/hosted';
import {
  HOSTED_TASK_BOARD_PAGE_HTTP_PATH,
  type HostedTaskBoardFetchPort,
} from '@features/team-task-board/renderer';
import {
  HostedTeamWorkspace,
  type HostedTeamWorkspaceProps,
} from '@renderer/components/team/HostedTeamWorkspace';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
