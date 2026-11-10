import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CommandPalette } from '@renderer/components/search/CommandPalette';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchSessionsResult } from '@main/types/domain';

const mocks = vi.hoisted(() => ({
  searchSessions: vi.fn(),
  searchAllProjects: vi.fn(),
  state: {
    commandPaletteOpen: true,
    selectedProjectId: 'project-a' as string | null,
    repositoryGroups: [],
    closeCommandPalette: vi.fn(),
    navigateToSession: vi.fn(),
    fetchRepositoryGroups: vi.fn(),
    selectRepository: vi.fn(),
  },
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/api', () => ({ api: mocks }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}));
vi.mock('@renderer/hooks/useOverlayOccupancy', () => ({ useOverlayOccupancy: vi.fn() }));

function deferredSearch() {
  let resolve!: (value: SearchSessionsResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<SearchSessionsResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function result(title: string): SearchSessionsResult {
  return {
    results: [
      {
        sessionId: title,
        projectId: 'project-a',
        sessionTitle: title,
        matchedText: title,
        context: title,
        messageType: 'user',
        timestamp: Date.now(),
      },
    ],
    totalMatches: 1,
    sessionsSearched: 1,
    query: title,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush<T>(action: () => T | Promise<T>) {
  await act(async () => {
    await action();
  });
}

async function renderPalette() {
  await flush(() => root.render(<CommandPalette />));
}

async function typeQuery(value: string) {
  const input = container.querySelector('input')!;
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter() {
  await flush(() => {
    container
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function debounce() {
  await flush(() => vi.advanceTimersByTimeAsync(400));
}

function isLoading() {
  return container.querySelector('.animate-spin') !== null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  mocks.state.commandPaletteOpen = true;
  mocks.state.selectedProjectId = 'project-a';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await renderPalette();
});

afterEach(async () => {
  await flush(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CommandPalette search lifecycle', () => {
  it('ignores an old response while the next query is still debouncing', async () => {
    const old = deferredSearch();
    const current = deferredSearch();
    mocks.searchSessions.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await typeQuery('old');
    await debounce();
    await typeQuery('current');
    await flush(() => old.resolve(result('Old session')));
    expect(container.textContent).not.toContain('Old session');
    await pressEnter();
    expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
    await debounce();
    expect(mocks.searchSessions).toHaveBeenLastCalledWith('project-a', 'current', 50);
    await flush(() => current.resolve(result('Current session')));
    expect(container.textContent).toContain('Current session');
    await pressEnter();
    expect(mocks.state.navigateToSession).toHaveBeenCalledWith(
      'project-a',
      'Current session',
      true,
      expect.objectContaining({ query: 'current' })
    );
  });

  it.each(['', 'x'])(
    'clears loading and prevents hidden stale navigation for query %j',
    async (query) => {
      const old = deferredSearch();
      mocks.searchSessions.mockReturnValueOnce(old.promise);
      await typeQuery('old');
      await debounce();
      expect(isLoading()).toBe(true);
      await typeQuery(query);
      expect(isLoading()).toBe(false);
      await flush(() => old.resolve(result('Old session')));
      await pressEnter();
      expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
      await debounce();
      expect(mocks.searchSessions).toHaveBeenCalledTimes(1);
    }
  );

  it('does not retain selectable results from the previous query', async () => {
    mocks.searchSessions.mockResolvedValueOnce(result('Old session'));
    await typeQuery('old');
    await debounce();
    expect(container.textContent).toContain('Old session');
    await typeQuery('current');
    await pressEnter();
    expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Old session');
  });

  it('ignores a response after closing and reopening the palette', async () => {
    const old = deferredSearch();
    mocks.searchSessions.mockReturnValueOnce(old.promise);
    await typeQuery('old');
    await debounce();
    mocks.state.commandPaletteOpen = false;
    await renderPalette();
    mocks.state.commandPaletteOpen = true;
    await renderPalette();
    await flush(() => old.resolve(result('Old session')));
    await pressEnter();
    expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
    expect(isLoading()).toBe(false);
  });

  it('ignores global results after switching back to project search', async () => {
    const global = deferredSearch();
    mocks.searchAllProjects.mockReturnValueOnce(global.promise);
    const toggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'commandPalette.global'
    )!;
    await flush(() => toggle.click());
    await typeQuery('old');
    await debounce();
    await flush(() => toggle.click());
    await flush(() => global.resolve(result('Global session')));
    expect(container.textContent).not.toContain('Global session');
    await pressEnter();
    expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
  });

  it('ignores results for a previously selected project', async () => {
    const old = deferredSearch();
    mocks.searchSessions.mockReturnValueOnce(old.promise);
    await typeQuery('query');
    await debounce();
    mocks.state.selectedProjectId = 'project-b';
    await renderPalette();
    await flush(() => old.resolve(result('Project A session')));
    expect(container.textContent).not.toContain('Project A session');
    await pressEnter();
    expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
  });

  it('does not let a stale error end loading for the next query', async () => {
    const old = deferredSearch();
    const current = deferredSearch();
    mocks.searchSessions.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await typeQuery('old');
    await debounce();
    await typeQuery('current');
    await flush(() => old.reject(new Error('Old search failed')));
    expect(isLoading()).toBe(true);
    await debounce();
    await flush(() => current.resolve(result('Current session')));
    expect(container.textContent).toContain('Current session');
    expect(isLoading()).toBe(false);
  });
});
