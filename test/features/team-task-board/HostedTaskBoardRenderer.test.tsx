import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type ExecuteHostedTaskMutationResult,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  type HostedTaskBoardItem,
  type HostedTaskBoardPage as HostedTaskBoardPageContract,
  type HostedTaskMutationCommand,
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
import { parseCursor, parseMemberId, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const firstTaskId = parseHostedTaskId(`task_${'b'.repeat(32)}`);
const secondTaskId = parseHostedTaskId(`task_${'c'.repeat(32)}`);
const thirdTaskId = parseHostedTaskId(`task_${'e'.repeat(32)}`);
const memberId = parseMemberId(`member_${'d'.repeat(32)}`);
const otherMemberId = parseMemberId(`member_${'f'.repeat(32)}`);
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

function mutationReceipt<TOutcome extends 'committed' | 'idempotent_replay'>(
  command: HostedTaskMutationCommand,
  outcome: TOutcome
) {
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    outcome,
    commandId: command.commandId,
    teamId: command.teamId,
    sourceGeneration: command.expectedSourceGeneration,
    revision: secondRevision,
    affectedTaskIds: Object.freeze([
      command.kind === 'create_task' || command.kind === 'reorder_column'
        ? firstTaskId
        : command.taskId,
    ]),
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

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
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

  it('fences an older first-page response behind an external revision event watermark', async () => {
    const staleHttpPage = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const eventRefresh = deferred<{ kind: 'success'; page: HostedTaskBoardPageContract }>();
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockReturnValueOnce(staleHttpPage.promise)
      .mockReturnValueOnce(eventRefresh.promise);
    const revisionEventListener: {
      value:
        | Parameters<NonNullable<HostedTaskBoardTransport['subscribeToRevisionEvents']>>[1]
        | null;
    } = { value: null };
    const subscribeToRevisionEvents: NonNullable<
      HostedTaskBoardTransport['subscribeToRevisionEvents']
    > = (_observedTeamId, listener) => {
      revisionEventListener.value = listener;
      return () => undefined;
    };
    const { host, root } = await renderPage({ getPage, subscribeToRevisionEvents });
    const emit = revisionEventListener.value;
    if (emit === null) {
      throw new Error('hosted-task-board-revision-listener-was-not-subscribed');
    }

    await act(async () => {
      emit({
        teamId,
        sourceGeneration: secondGeneration,
        revision: secondRevision,
      });
      await Promise.resolve();
    });
    expect(getPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleHttpPage.resolve({
        kind: 'success',
        page: page([item(firstTaskId, 'Stale HTTP task')]),
      });
      await staleHttpPage.promise;
    });
    expect(host.textContent).not.toContain('Stale HTTP task');

    await act(async () => {
      eventRefresh.resolve({
        kind: 'success',
        page: page([item(secondTaskId, 'External writer task', 'review')], {
          generation: secondGeneration,
          revision: secondRevision,
        }),
      });
      await eventRefresh.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('External writer task'));
    expect(host.textContent).not.toContain('Stale HTTP task');
    act(() => root.unmount());
  });

  it('dispatches details, owner, move, and reorder through the feature transport', async () => {
    const boardItems = [
      item(firstTaskId, 'First task', 'todo', 0),
      item(secondTaskId, 'Second task', 'todo', 1),
    ];
    const getPage = vi.fn<HostedTaskBoardTransport['getPage']>().mockResolvedValue({
      kind: 'success',
      page: page(boardItems),
    });
    const executeMutation = vi.fn<NonNullable<HostedTaskBoardTransport['executeMutation']>>(
      async (command) => ({
        kind: 'committed',
        receipt: mutationReceipt(command, 'committed'),
      })
    );
    const { host, root } = await renderPage({ getPage, executeMutation });
    await vi.waitFor(() => expect(host.textContent).toContain('First task'));

    const title = host.querySelector<HTMLInputElement>('[aria-label="Title for First task"]');
    const description = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Description for First task"]'
    );
    if (title === null || description === null) throw new Error('task-detail-controls-missing');
    await act(async () => {
      setControlValue(title, 'Renamed task');
      setControlValue(description, 'New details');
      buttonWithText(host, 'Save details')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(host.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
    );

    const owner = host.querySelector<HTMLInputElement>('[aria-label="Owner for First task"]');
    if (owner === null) throw new Error('task-owner-control-missing');
    await act(async () => {
      setControlValue(owner, memberId);
      buttonWithText(host, 'Save owner')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(host.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
    );

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Move First task right"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(host.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Move First task down"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(4));

    expect(executeMutation.mock.calls.map(([command]) => command)).toMatchObject([
      {
        kind: 'update_details',
        taskId: firstTaskId,
        subject: 'Renamed task',
        description: 'New details',
      },
      { kind: 'update_owner', taskId: firstTaskId, ownerId: memberId },
      { kind: 'move_task', taskId: firstTaskId, column: 'in_progress', order: 0 },
      { kind: 'reorder_column', column: 'todo', orderedTaskIds: [secondTaskId, firstTaskId] },
    ]);
    expect(buttonWithText(host, 'Next status')).toBeDefined();
    expect(buttonWithText(host, 'Save task')).toBeDefined();
    act(() => root.unmount());
  });

  it('resyncs details and owner drafts to the refreshed canonical revision before saving', async () => {
    const initialItem = Object.freeze({
      ...item(firstTaskId, 'Initial title'),
      description: 'Initial details',
    });
    const refreshedItem = Object.freeze({
      ...item(firstTaskId, 'Canonical title'),
      description: 'Canonical details',
      ownerId: memberId,
    });
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockResolvedValueOnce({ kind: 'success', page: page([initialItem]) })
      .mockResolvedValue({
        kind: 'success',
        page: page([refreshedItem], { revision: secondRevision }),
      });
    const executeMutation = vi.fn<NonNullable<HostedTaskBoardTransport['executeMutation']>>(
      async (command) => ({
        kind: 'committed',
        receipt: mutationReceipt(command, 'committed'),
      })
    );
    const { host, root } = await renderPage({ getPage, executeMutation });
    await vi.waitFor(() => expect(host.textContent).toContain('Initial title'));

    const staleTitle = host.querySelector<HTMLInputElement>(
      '[aria-label="Title for Initial title"]'
    );
    const staleDescription = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Description for Initial title"]'
    );
    const staleOwner = host.querySelector<HTMLInputElement>(
      '[aria-label="Owner for Initial title"]'
    );
    if (staleTitle === null || staleDescription === null || staleOwner === null) {
      throw new Error('task-draft-controls-missing');
    }
    await act(async () => {
      setControlValue(staleTitle, 'Unsaved stale title');
      setControlValue(staleDescription, 'Unsaved stale details');
      setControlValue(staleOwner, otherMemberId);
      host.querySelector<HTMLButtonElement>('button[aria-label="Refresh task board"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Canonical title'));

    const canonicalTitle = host.querySelector<HTMLInputElement>(
      '[aria-label="Title for Canonical title"]'
    );
    const canonicalDescription = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Description for Canonical title"]'
    );
    const canonicalOwner = host.querySelector<HTMLInputElement>(
      '[aria-label="Owner for Canonical title"]'
    );
    expect(canonicalTitle?.value).toBe('Canonical title');
    expect(canonicalDescription?.value).toBe('Canonical details');
    expect(canonicalOwner?.value).toBe(memberId);

    await act(async () => {
      buttonWithText(host, 'Save details')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(host.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
    );
    await act(async () => {
      buttonWithText(host, 'Save owner')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(2));
    expect(executeMutation.mock.calls.map(([command]) => command)).toMatchObject([
      {
        kind: 'update_details',
        subject: 'Canonical title',
        description: 'Canonical details',
        expectedRevision: secondRevision,
      },
      { kind: 'update_owner', ownerId: memberId, expectedRevision: secondRevision },
    ]);
    act(() => root.unmount());
  });

  it('disables whole-column ordering until pagination has loaded the complete board', async () => {
    const firstPageItems = [
      item(firstTaskId, 'First task', 'todo', 0),
      item(secondTaskId, 'Second task', 'todo', 1),
    ];
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockResolvedValueOnce({
        kind: 'success',
        page: page(firstPageItems, { cursor: nextCursor }),
      })
      .mockResolvedValueOnce({
        kind: 'success',
        page: page([item(thirdTaskId, 'Third task', 'todo', 2)]),
      });
    const executeMutation = vi.fn<NonNullable<HostedTaskBoardTransport['executeMutation']>>(
      async () => ({ kind: 'unavailable' })
    );
    const { host, root } = await renderPage({ getPage, executeMutation });
    await vi.waitFor(() => expect(host.textContent).toContain('First task'));

    const moveDown = host.querySelector<HTMLButtonElement>('[aria-label="Move First task down"]');
    const moveRight = host.querySelector<HTMLButtonElement>('[aria-label="Move First task right"]');
    expect(moveDown?.disabled).toBe(true);
    expect(moveRight?.disabled).toBe(true);
    expect(buttonWithText(host, 'Load more tasks')?.getAttribute('aria-label')).toContain(
      'task moves and whole-column ordering stay disabled'
    );
    await act(async () => {
      moveDown?.click();
      moveRight?.click();
      await Promise.resolve();
    });
    expect(executeMutation).not.toHaveBeenCalled();

    await act(async () => {
      buttonWithText(host, 'Load more tasks')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Third task'));
    const enabledMoveDown = host.querySelector<HTMLButtonElement>(
      '[aria-label="Move First task down"]'
    );
    const enabledMoveRight = host.querySelector<HTMLButtonElement>(
      '[aria-label="Move First task right"]'
    );
    expect(enabledMoveDown?.disabled).toBe(false);
    expect(enabledMoveRight?.disabled).toBe(false);
    expect(buttonWithText(host, 'Load more tasks')).toBeUndefined();
    await act(async () => {
      enabledMoveDown?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledOnce());
    expect(executeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reorder_column',
        orderedTaskIds: [secondTaskId, firstTaskId, thirdTaskId],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    act(() => root.unmount());
  });

  it('disables details and owner editing while a save and canonical reload are in flight', async () => {
    const mutation = deferred<Extract<ExecuteHostedTaskMutationResult, { kind: 'committed' }>>();
    const canonicalItem = Object.freeze({
      ...item(firstTaskId, 'Saved title'),
      description: 'Saved details',
      ownerId: memberId,
    });
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockResolvedValueOnce({ kind: 'success', page: page([item(firstTaskId, 'Initial title')]) })
      .mockResolvedValueOnce({
        kind: 'success',
        page: page([canonicalItem], { revision: secondRevision }),
      });
    const executeMutation = vi.fn<NonNullable<HostedTaskBoardTransport['executeMutation']>>(
      () => mutation.promise
    );
    const { host, root } = await renderPage({ getPage, executeMutation });
    await vi.waitFor(() => expect(host.textContent).toContain('Initial title'));

    const title = host.querySelector<HTMLInputElement>('[aria-label="Title for Initial title"]');
    if (title === null) throw new Error('task-title-control-missing');
    await act(async () => {
      setControlValue(title, 'Submitted title');
      buttonWithText(host, 'Save details')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(executeMutation).toHaveBeenCalledOnce());
    expect(title.disabled).toBe(true);
    expect(
      host.querySelector<HTMLTextAreaElement>('[aria-label="Description for Initial title"]')
        ?.disabled
    ).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Owner for Initial title"]')?.disabled
    ).toBe(true);

    const submitted = executeMutation.mock.calls[0]?.[0];
    if (submitted === undefined) throw new Error('hosted-task-board-mutation-was-not-issued');
    await act(async () => {
      mutation.resolve({
        kind: 'committed',
        receipt: mutationReceipt(submitted, 'committed'),
      });
      await mutation.promise;
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Saved title'));
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Title for Saved title"]')?.value
    ).toBe('Saved title');
    expect(
      host.querySelector<HTMLTextAreaElement>('[aria-label="Description for Saved title"]')?.value
    ).toBe('Saved details');
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Owner for Saved title"]')?.value
    ).toBe(memberId);
    act(() => root.unmount());
  });

  it('reuses the in-memory command for recovery and reloads canonical data after replay', async () => {
    let attempts = 0;
    const executeMutation = vi.fn(async (command: HostedTaskMutationCommand) => {
      attempts += 1;
      return attempts === 1
        ? Object.freeze({ kind: 'unavailable' as const })
        : Object.freeze({
            kind: 'idempotent_replay' as const,
            receipt: mutationReceipt(command, 'idempotent_replay'),
          });
    });
    const getPage = vi
      .fn<HostedTaskBoardTransport['getPage']>()
      .mockResolvedValueOnce({ kind: 'success', page: page([item(firstTaskId, 'Before retry')]) })
      .mockResolvedValueOnce({
        kind: 'success',
        page: page([item(firstTaskId, 'After replay', 'done')], {
          generation: secondGeneration,
          revision: secondRevision,
        }),
      });
    const { host, root } = await renderPage({ getPage, executeMutation });
    await vi.waitFor(() => expect(host.textContent).toContain('Before retry'));

    await act(async () => {
      buttonWithText(host, 'Next status')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Retry task change'));
    await act(async () => {
      buttonWithText(host, 'Retry task change')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('After replay'));
    expect(executeMutation).toHaveBeenCalledTimes(2);
    expect(executeMutation.mock.calls[1]?.[0]).toBe(executeMutation.mock.calls[0]?.[0]);
    expect(executeMutation.mock.calls[0]?.[0]).toMatchObject({
      kind: 'update_status',
      expectedSourceGeneration: firstGeneration,
      expectedRevision: firstRevision,
    });
    expect(host.innerHTML).not.toContain('localStorage');
    act(() => root.unmount());
  });

  it('drops a late mutation completion after the transport is rebound', async () => {
    const lateMutation =
      deferred<Extract<ExecuteHostedTaskMutationResult, { kind: 'committed' }>>();
    let issued: HostedTaskMutationCommand | null = null;
    const oldTransport: HostedTaskBoardTransport = {
      getPage: vi.fn(() =>
        Promise.resolve({ kind: 'success' as const, page: page([item(firstTaskId, 'Old board')]) })
      ),
      executeMutation: vi.fn((command: HostedTaskMutationCommand) => {
        issued = command;
        return lateMutation.promise;
      }),
    };
    const currentTransport: HostedTaskBoardTransport = {
      getPage: vi.fn(() =>
        Promise.resolve({
          kind: 'success' as const,
          page: page([item(secondTaskId, 'Rebound board')], {
            generation: secondGeneration,
            revision: secondRevision,
          }),
        })
      ),
    };
    const { host, root } = await renderPage(oldTransport);
    await vi.waitFor(() => expect(host.textContent).toContain('Old board'));

    await act(async () => {
      buttonWithText(host, 'Next status')?.click();
      await Promise.resolve();
      root.render(<HostedTaskBoardPage teamId={teamId} transport={currentTransport} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Rebound board'));
    const issuedCommand = issued;
    if (issuedCommand === null) throw new Error('hosted-task-board-mutation-was-not-issued');
    await act(async () => {
      lateMutation.resolve({
        kind: 'committed',
        receipt: mutationReceipt(issuedCommand, 'committed'),
      });
      await lateMutation.promise;
    });
    expect(host.textContent).toContain('Rebound board');
    expect(host.textContent).not.toContain('Old board');
    expect(currentTransport.getPage).toHaveBeenCalledOnce();
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
