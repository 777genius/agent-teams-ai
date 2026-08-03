import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  type HostedTaskBoardItem,
  type HostedTaskBoardPage as HostedTaskBoardPageContract,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
} from '@features/team-task-board/contracts/hosted';
import {
  createHostedTaskBoardTransport,
  HOSTED_TASK_BOARD_PAGE_HTTP_PATH,
  type HostedTaskBoardFetchPort,
  HostedTaskBoardPage,
  type HostedTaskBoardTransport,
} from '@features/team-task-board/renderer';
import { parseCursor, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const firstTaskId = parseHostedTaskId(`task_${'b'.repeat(32)}`);
const secondTaskId = parseHostedTaskId(`task_${'c'.repeat(32)}`);
const firstGeneration = parseHostedTaskBoardSourceGeneration('generation_renderer-1');
const secondGeneration = parseHostedTaskBoardSourceGeneration('generation_renderer-2');
const firstRevision = parseRevision('revision_renderer-1');
const secondRevision = parseRevision('revision_renderer-2');
const nextCursor = parseCursor('cursor_renderer-next');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function item(
  taskId: typeof firstTaskId,
  subject: string,
  column: HostedTaskBoardItem['column'] = 'todo',
  order = 0
): HostedTaskBoardItem {
  return Object.freeze({
    teamId,
    taskId,
    subject,
    description: null,
    status: column === 'done' ? 'completed' : 'pending',
    ownerId: null,
    column,
    order,
    blockedByTaskIds: Object.freeze([]),
    blocksTaskIds: Object.freeze([]),
    relatedTaskIds: Object.freeze([]),
  });
}

function page(
  items: readonly HostedTaskBoardItem[],
  options: {
    readonly generation?: typeof firstGeneration;
    readonly revision?: typeof firstRevision;
    readonly cursor?: typeof nextCursor | null;
    readonly degraded?: boolean;
    readonly limit?: number;
  } = {}
): HostedTaskBoardPageContract {
  const cursor = options.cursor ?? null;
  const degraded = options.degraded ?? false;
  const truncationReasons: HostedTaskBoardPageContract['truncationReasons'] =
    cursor === null ? Object.freeze([]) : Object.freeze(['item_budget'] as const);
  const degradedReasons: HostedTaskBoardPageContract['degraded']['reasons'] = degraded
    ? Object.freeze(['source_stale'] as const)
    : Object.freeze([]);
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    kind: 'task_board_page',
    teamId,
    sourceGeneration: options.generation ?? firstGeneration,
    revision: options.revision ?? firstRevision,
    items: Object.freeze([...items]),
    nextCursor: cursor,
    truncated: cursor !== null,
    truncationReasons,
    degraded: Object.freeze({
      active: degraded,
      reasons: degradedReasons,
    }),
    budget: Object.freeze({
      itemLimit: options.limit ?? 25,
      byteLimit: 256 * 1024,
      timeLimitMs: 250,
      usedItems: items.length,
      usedBytes: 2_200 + items.length * 80,
      elapsedMs: 1,
    }),
  });
}

async function renderPage(
  transport: HostedTaskBoardTransport
): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<HostedTaskBoardPage teamId={teamId} transport={transport} />);
    await Promise.resolve();
  });
  return { host, root };
}

function buttonWithText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text)
  );
}

describe('hosted task-board renderer', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses only the injected authenticated HTTP port and validates success and stale envelopes', async () => {
    const first = item(firstTaskId, 'First task');
    const fetch = vi.fn<HostedTaskBoardFetchPort>().mockResolvedValueOnce({
      status: 200,
      json: async () => page([first], { cursor: nextCursor, limit: 2 }),
    });
    const transport = createHostedTaskBoardTransport({
      fetch,
      getCsrfToken: () => 'c'.repeat(32),
    });
    const request = Object.freeze({
      schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
      teamId,
      cursor: null,
      expectedSourceGeneration: null,
      limit: 2,
    });

    await expect(transport.getPage(request)).resolves.toMatchObject({
      kind: 'success',
      page: {
        items: [first],
        nextCursor,
        sourceGeneration: firstGeneration,
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
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
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body ?? '')).toEqual(request);

    fetch.mockResolvedValueOnce({
      status: 409,
      json: async () => ({
        schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
        kind: 'error',
        error: { code: 'conflict', reason: 'stale_generation' },
        retryable: false,
        currentSourceGeneration: secondGeneration,
      }),
    });
    await expect(
      transport.getPage({
        ...request,
        cursor: nextCursor,
        expectedSourceGeneration: firstGeneration,
      })
    ).resolves.toEqual({
      kind: 'stale_generation',
      currentSourceGeneration: secondGeneration,
    });

    fetch.mockResolvedValueOnce({ status: 200, json: async () => ({ secret: 'raw-server-data' }) });
    await expect(transport.getPage(request)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('shows loading, paginates against one generation, and replaces content on refresh', async () => {
    const initial = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const more = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const refreshed = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(more.promise)
      .mockReturnValueOnce(refreshed.promise);
    const { host, root } = await renderPage({ getPage });

    expect(host.textContent).toContain('Loading task board…');
    await act(async () => {
      initial.resolve({
        kind: 'success',
        page: page([item(firstTaskId, 'First page task')], { cursor: nextCursor }),
      });
      await initial.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('First page task'));
    expect(host.querySelector('[title]')).toBeNull();
    expect(host.querySelector('[aria-label="Read-only task board"]')).not.toBeNull();

    await act(async () => {
      buttonWithText(host, 'Load more tasks')?.click();
      await Promise.resolve();
    });
    expect(getPage.mock.calls[1]?.[0]).toMatchObject({
      cursor: nextCursor,
      expectedSourceGeneration: firstGeneration,
    });
    await act(async () => {
      more.resolve({
        kind: 'success',
        page: page([item(secondTaskId, 'Second page task', 'done')]),
      });
      await more.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Second page task'));
    expect(host.querySelectorAll('[data-task-id]')).toHaveLength(2);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Refresh task board"]')?.click();
      await Promise.resolve();
    });
    expect(getPage.mock.calls[2]?.[0]).toMatchObject({
      cursor: null,
      expectedSourceGeneration: null,
    });
    expect(host.textContent).toContain('First page task');
    await act(async () => {
      refreshed.resolve({
        kind: 'success',
        page: page([item(secondTaskId, 'Current task', 'review')], {
          generation: secondGeneration,
          revision: secondRevision,
        }),
      });
      await refreshed.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Current task'));
    expect(host.textContent).not.toContain('First page task');
    expect(host.querySelectorAll('[data-task-id]')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('marks stale pagination, reloads from the first page, and never mixes generations', async () => {
    const current = item(firstTaskId, 'Old generation task');
    const replacement = item(secondTaskId, 'New generation task', 'in_progress');
    const fresh = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockResolvedValueOnce({ kind: 'success', page: page([current], { cursor: nextCursor }) })
      .mockResolvedValueOnce({
        kind: 'stale_generation',
        currentSourceGeneration: secondGeneration,
      })
      .mockReturnValueOnce(fresh.promise);
    const { host, root } = await renderPage({ getPage });
    await vi.waitFor(() => expect(host.textContent).toContain('Old generation task'));

    await act(async () => {
      buttonWithText(host, 'Load more tasks')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('The task board changed. Refreshing the current board…');
    expect(host.textContent).toContain('Old generation task');
    expect(getPage.mock.calls[1]?.[0]).toMatchObject({
      cursor: nextCursor,
      expectedSourceGeneration: firstGeneration,
    });
    expect(getPage.mock.calls[2]?.[0]).toMatchObject({
      cursor: null,
      expectedSourceGeneration: null,
    });

    await act(async () => {
      fresh.resolve({
        kind: 'success',
        page: page([replacement], {
          generation: secondGeneration,
          revision: secondRevision,
        }),
      });
      await fresh.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('New generation task'));
    expect(host.textContent).not.toContain('Old generation task');
    expect(host.querySelectorAll('[data-task-id]')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('ignores an older transport generation after the page dependency is rebound', async () => {
    const oldLoad = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const currentLoad = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const oldTransport: HostedTaskBoardTransport = { getPage: () => oldLoad.promise };
    const currentTransport: HostedTaskBoardTransport = { getPage: () => currentLoad.promise };
    const { host, root } = await renderPage(oldTransport);

    await act(async () => {
      root.render(<HostedTaskBoardPage teamId={teamId} transport={currentTransport} />);
      await Promise.resolve();
    });
    await act(async () => {
      currentLoad.resolve({
        kind: 'success',
        page: page([item(secondTaskId, 'Current transport task')], {
          generation: secondGeneration,
          revision: secondRevision,
        }),
      });
      await currentLoad.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Current transport task'));

    await act(async () => {
      oldLoad.resolve({ kind: 'success', page: page([item(firstTaskId, 'Old transport task')]) });
      await oldLoad.promise;
    });
    expect(host.textContent).toContain('Current transport task');
    expect(host.textContent).not.toContain('Old transport task');
    act(() => root.unmount());
  });

  it('renders a fixed safe error and can recover without exposing transport details', async () => {
    const privateFailure = 'internal transport detail that must stay hidden';
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockRejectedValueOnce(new Error(privateFailure))
      .mockResolvedValueOnce({ kind: 'success', page: page([]) });
    const { host, root } = await renderPage({ getPage });

    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.textContent).toContain(
      'The task board is temporarily unavailable. Refresh to try again.'
    );
    expect(host.textContent).not.toContain(privateFailure);
    expect(host.innerHTML).not.toContain('must stay hidden');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Refresh task board"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('This team has no tasks.'));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    act(() => root.unmount());
  });
});
