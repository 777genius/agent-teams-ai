import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.textContent).toContain(
      'The task board is temporarily unavailable. Refresh to try again.'
    );
    expect(host.textContent).not.toContain(privateFailure);
    expect(host.innerHTML).not.toContain('/private/workspaces');
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
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(messageFetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'Messages are temporarily unavailable. Refresh to try again.'
    );
    expect(host.innerHTML).not.toContain('csrf');
    act(() => root.unmount());
  });
});
