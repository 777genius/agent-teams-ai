import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type TeamWorktreeGitReadinessRendererPorts,
  useWorktreeGitReadiness,
  type WorktreeGitReadinessState,
} from '@features/team-provisioning/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamWorktreeGitStatus } from '@shared/types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

function gitStatus(
  projectPath: string,
  overrides: Partial<TeamWorktreeGitStatus> = {}
): TeamWorktreeGitStatus {
  return {
    projectPath,
    isGitRepo: true,
    hasHead: true,
    canUseWorktrees: true,
    branch: 'main',
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useWorktreeGitReadiness', () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: WorktreeGitReadinessState | null;
  let getStatus: ReturnType<typeof vi.fn<TeamWorktreeGitReadinessRendererPorts['getStatus']>>;
  let initialize: ReturnType<typeof vi.fn<TeamWorktreeGitReadinessRendererPorts['initialize']>>;
  let createInitialCommit: ReturnType<
    typeof vi.fn<TeamWorktreeGitReadinessRendererPorts['createInitialCommit']>
  >;
  let ports: TeamWorktreeGitReadinessRendererPorts;

  function Harness({
    enabled,
    projectPath,
  }: Readonly<{
    enabled: boolean;
    projectPath: string | null;
  }>): React.JSX.Element | null {
    latest = useWorktreeGitReadiness(projectPath, enabled, ports);
    return null;
  }

  async function render(projectPath: string | null, enabled = true): Promise<void> {
    await act(async () => {
      root.render(React.createElement(Harness, { enabled, projectPath }));
      await flushPromises();
    });
  }

  function state(): WorktreeGitReadinessState {
    if (!latest) {
      throw new Error('Hook state was not captured');
    }
    return latest;
  }

  beforeEach(() => {
    getStatus = vi.fn<TeamWorktreeGitReadinessRendererPorts['getStatus']>();
    initialize = vi.fn<TeamWorktreeGitReadinessRendererPorts['initialize']>();
    createInitialCommit = vi.fn<TeamWorktreeGitReadinessRendererPorts['createInitialCommit']>();
    ports = { getStatus, initialize, createInitialCommit };
    latest = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('keeps empty and disabled scopes idle and clears prior readiness state', async () => {
    await render('   ');
    await render('/sandbox/disabled', false);

    expect(getStatus).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      status: null,
      loading: false,
      actionLoading: null,
      error: null,
    });

    getStatus.mockResolvedValueOnce(gitStatus('/sandbox/enabled'));
    await render('/sandbox/enabled');
    expect(state().status).toEqual(gitStatus('/sandbox/enabled'));

    await render('/sandbox/enabled', false);
    expect(state()).toMatchObject({
      status: null,
      loading: false,
      actionLoading: null,
      error: null,
    });

    await act(async () => {
      await state().refresh();
      await state().initializeRepository();
      await state().createInitialCommit();
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(initialize).not.toHaveBeenCalled();
    expect(createInitialCommit).not.toHaveBeenCalled();
  });

  it('preserves loading, refresh, and inspection error behavior', async () => {
    const initial = deferred<TeamWorktreeGitStatus>();
    getStatus.mockReturnValueOnce(initial.promise);

    await render('/sandbox/project');
    expect(state()).toMatchObject({
      status: null,
      loading: true,
      error: null,
    });

    const notReady = gitStatus('/sandbox/project', {
      isGitRepo: false,
      hasHead: false,
      canUseWorktrees: false,
      branch: undefined,
      reason: 'not_git_repo',
      message: 'Initialize Git before using worktrees.',
    });
    await act(async () => {
      initial.resolve(notReady);
      await initial.promise;
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: notReady,
      loading: false,
      error: null,
    });

    const failedRefresh = deferred<TeamWorktreeGitStatus>();
    getStatus.mockReturnValueOnce(failedRefresh.promise);
    let failedRefreshPromise!: Promise<void>;
    act(() => {
      failedRefreshPromise = state().refresh();
    });
    expect(state()).toMatchObject({ loading: true, error: null });

    await act(async () => {
      failedRefresh.reject('untyped failure');
      await failedRefreshPromise;
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: null,
      loading: false,
      error: 'Failed to inspect Git repository',
    });

    const ready = gitStatus('/sandbox/project', { branch: 'feature/latest' });
    getStatus.mockResolvedValueOnce(ready);
    await act(async () => {
      await state().refresh();
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: ready,
      loading: false,
      error: null,
    });
    expect(getStatus).toHaveBeenNthCalledWith(1, '/sandbox/project');
    expect(getStatus).toHaveBeenNthCalledWith(2, '/sandbox/project');
    expect(getStatus).toHaveBeenNthCalledWith(3, '/sandbox/project');
  });

  it('preserves initialization and initial-commit loading and error behavior', async () => {
    const notRepository = gitStatus('/sandbox/project', {
      isGitRepo: false,
      hasHead: false,
      canUseWorktrees: false,
      branch: undefined,
      reason: 'not_git_repo',
    });
    getStatus.mockResolvedValueOnce(notRepository);
    await render('/sandbox/project');

    const initializing = deferred<TeamWorktreeGitStatus>();
    initialize.mockReturnValueOnce(initializing.promise);
    let initializationPromise!: Promise<void>;
    act(() => {
      initializationPromise = state().initializeRepository();
    });
    expect(state()).toMatchObject({ actionLoading: 'init', error: null });

    const missingHead = gitStatus('/sandbox/project', {
      hasHead: false,
      canUseWorktrees: false,
      branch: undefined,
      reason: 'missing_head',
    });
    await act(async () => {
      initializing.resolve(missingHead);
      await initializationPromise;
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: missingHead,
      actionLoading: null,
      error: null,
    });
    expect(initialize).toHaveBeenCalledWith('/sandbox/project');

    createInitialCommit.mockRejectedValueOnce(new Error('commit identity is unavailable'));
    await act(async () => {
      await state().createInitialCommit();
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: missingHead,
      actionLoading: null,
      error: 'commit identity is unavailable',
    });
    expect(createInitialCommit).toHaveBeenCalledWith('/sandbox/project');
  });

  it('prevents stale project requests and actions from overwriting the latest scope', async () => {
    const projectAStatus = deferred<TeamWorktreeGitStatus>();
    const projectBStatus = deferred<TeamWorktreeGitStatus>();
    getStatus
      .mockReturnValueOnce(projectAStatus.promise)
      .mockReturnValueOnce(projectBStatus.promise);

    await render('/sandbox/project-a');
    await render('/sandbox/project-b');

    await act(async () => {
      projectAStatus.resolve(
        gitStatus('/sandbox/project-a', {
          isGitRepo: false,
          hasHead: false,
          canUseWorktrees: false,
          branch: undefined,
          reason: 'not_git_repo',
        })
      );
      await projectAStatus.promise;
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: null,
      loading: true,
      error: null,
    });

    const projectBReady = gitStatus('/sandbox/project-b', { branch: 'project-b' });
    await act(async () => {
      projectBStatus.resolve(projectBReady);
      await projectBStatus.promise;
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: projectBReady,
      loading: false,
      error: null,
    });

    const staleInitialization = deferred<TeamWorktreeGitStatus>();
    initialize.mockReturnValueOnce(staleInitialization.promise);
    let staleInitializationPromise!: Promise<void>;
    act(() => {
      staleInitializationPromise = state().initializeRepository();
    });

    const projectCStatus = deferred<TeamWorktreeGitStatus>();
    getStatus.mockReturnValueOnce(projectCStatus.promise);
    await render('/sandbox/project-c');
    expect(state()).toMatchObject({ loading: true, actionLoading: null });

    await act(async () => {
      staleInitialization.resolve(gitStatus('/sandbox/project-b', { branch: 'stale-action' }));
      await staleInitializationPromise;
      await flushPromises();
    });
    expect(state().status).toBe(projectBReady);
    expect(state()).toMatchObject({ loading: true, actionLoading: null, error: null });

    const projectCReady = gitStatus('/sandbox/project-c', { branch: 'project-c' });
    await act(async () => {
      projectCStatus.resolve(projectCReady);
      await projectCStatus.promise;
      await flushPromises();
    });
    expect(state()).toMatchObject({
      status: projectCReady,
      loading: false,
      actionLoading: null,
      error: null,
    });
  });

  it('applies only the latest same-scope refresh result', async () => {
    getStatus.mockResolvedValueOnce(gitStatus('/sandbox/project', { branch: 'initial' }));
    await render('/sandbox/project');

    const olderRefresh = deferred<TeamWorktreeGitStatus>();
    const latestRefresh = deferred<TeamWorktreeGitStatus>();
    getStatus.mockReturnValueOnce(olderRefresh.promise).mockReturnValueOnce(latestRefresh.promise);

    let olderPromise!: Promise<void>;
    let latestPromise!: Promise<void>;
    act(() => {
      olderPromise = state().refresh();
      latestPromise = state().refresh();
    });

    const latestStatus = gitStatus('/sandbox/project', { branch: 'latest' });
    await act(async () => {
      latestRefresh.resolve(latestStatus);
      await latestPromise;
      await flushPromises();
    });
    expect(state()).toMatchObject({ status: latestStatus, loading: false, error: null });

    await act(async () => {
      olderRefresh.resolve(gitStatus('/sandbox/project', { branch: 'stale' }));
      await olderPromise;
      await flushPromises();
    });
    expect(state()).toMatchObject({ status: latestStatus, loading: false, error: null });
  });
});
