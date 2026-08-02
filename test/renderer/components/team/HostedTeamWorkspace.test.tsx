import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';
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

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const REVISION = parseRevision('revision_hosted-workspace');
const SOURCE_GENERATION = parseHostedTaskBoardSourceGeneration('generation_hosted-workspace');

function lifecycleResult(): CanonicalListTeamLifecycleResult {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision: REVISION,
    items: Object.freeze([
      Object.freeze({
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
        displayName: 'Browser Team',
        lifecycle: 'running',
        revision: REVISION,
      }),
    ]),
    nextCursor: null,
  });
}

function taskBoardPage() {
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    kind: 'task_board_page',
    teamId: TEAM_ID,
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

async function renderWorkspace(
  props: Required<HostedTeamWorkspaceProps>
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
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

function teamButton(host: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes('Browser Team')
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
    const getCsrfToken = vi.fn(() => 'c'.repeat(32));
    const { host, root } = await renderWorkspace({
      lifecycleTransport,
      fetch,
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
});
