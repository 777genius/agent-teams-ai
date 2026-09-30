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
vi.mock('@renderer/hooks/useOverlayOccupancy', () => ({ OverlayOccupancyMarker: () => null }));

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

let container: HTMLElement;
let mountNode: HTMLDivElement;
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

async function pressKey(key: string, options: KeyboardEventInit = {}) {
  await flush(() => {
    container
      .querySelector('input')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
      );
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
  mountNode = document.createElement('div');
  document.body.append(mountNode);
  container = document.body;
  root = createRoot(mountNode);
  await renderPalette();
});

afterEach(async () => {
  await flush(() => root.unmount());
  mountNode.remove();
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

  it('shows a current search failure instead of a no-results message', async () => {
    mocks.searchSessions.mockRejectedValueOnce(new Error('Read failed'));
    await typeQuery('query');
    await debounce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('states.error');
    expect(container.textContent).not.toContain('commandPalette.empty.noResults');
    expect(isLoading()).toBe(false);
  });

  it('passes exact session match anchors to the viewer', async () => {
    const anchored = result('Anchor');
    Object.assign(anchored.results[0], {
      groupId: 'group-17',
      matchIndexInItem: 3,
      matchStartOffset: 42,
      messageUuid: 'uuid-17',
      timestamp: 1700000000000,
    });
    mocks.searchSessions.mockResolvedValueOnce(anchored);
    await typeQuery('anchor');
    await debounce();
    await pressEnter();
    expect(mocks.state.navigateToSession).toHaveBeenCalledWith('project-a', 'Anchor', true, {
      query: 'anchor',
      messageTimestamp: 1700000000000,
      matchedText: 'Anchor',
      targetGroupId: 'group-17',
      targetMatchIndexInItem: 3,
      targetMatchStartOffset: 42,
      targetMessageUuid: 'uuid-17',
    });
  });

  it('leaves Enter and arrows to an active IME', async () => {
    mocks.searchSessions.mockResolvedValueOnce(result('Session'));
    await typeQuery('session');
    await debounce();
    await pressKey('ArrowDown', { isComposing: true });
    await pressKey('Enter', { isComposing: true });
    expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
    await pressEnter();
    expect(mocks.state.navigateToSession).toHaveBeenCalledTimes(1);
  });

  it('keeps IME Escape in the input and closes on a plain Escape', async () => {
    expect(mocks.state.closeCommandPalette).not.toHaveBeenCalled();
    await pressKey('Escape', { isComposing: true });
    expect(mocks.state.closeCommandPalette).not.toHaveBeenCalled();

    await flush(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'keyCode', { value: 229 });
      container.querySelector('input')!.dispatchEvent(event);
    });
    expect(mocks.state.closeCommandPalette).not.toHaveBeenCalled();

    await pressKey('Escape');
    expect(mocks.state.closeCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the element active before opening', async () => {
    mocks.state.commandPaletteOpen = false;
    await renderPalette();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    try {
      trigger.focus();
      mocks.state.commandPaletteOpen = true;
      await renderPalette();
      expect(document.activeElement).toBe(container.querySelector('input'));

      mocks.state.closeCommandPalette.mockImplementationOnce(() => {
        mocks.state.commandPaletteOpen = false;
      });
      await pressKey('Escape');
      await renderPalette();
      await flush(() => vi.advanceTimersByTimeAsync(0));
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it('does not focus a trigger removed while the palette is open', async () => {
    mocks.state.commandPaletteOpen = false;
    await renderPalette();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const focus = vi.spyOn(trigger, 'focus');
    trigger.focus();
    mocks.state.commandPaletteOpen = true;
    await renderPalette();
    focus.mockClear();
    trigger.remove();

    mocks.state.commandPaletteOpen = false;
    await renderPalette();
    await flush(() => vi.advanceTimersByTimeAsync(0));
    expect(focus).not.toHaveBeenCalled();
  });

  it('keeps empty project navigation inert', async () => {
    mocks.state.selectedProjectId = null;
    await renderPalette();
    await pressKey('ArrowDown');
    await pressEnter();
    expect(mocks.state.selectRepository).not.toHaveBeenCalled();
    expect(mocks.state.navigateToSession).not.toHaveBeenCalled();
  });
});
