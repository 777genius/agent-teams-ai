import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { useTerminalCommandAutocomplete } from '@features/terminal-workspace/renderer/hooks/useTerminalCommandAutocomplete';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AutocompleteState {
  autocompleteSuggestion: string | null;
}

interface HookProbeOptions {
  commandHistory?: readonly string[];
  cwd?: string | null;
  paneId?: string | null;
  sessionId?: string | null;
}

function HookProbe({
  eventSource,
  onState,
  options = {},
}: {
  eventSource: EventTarget;
  onState: (state: AutocompleteState) => void;
  options?: HookProbeOptions;
}): null {
  const state = useTerminalCommandAutocomplete({
    commandHistory: options.commandHistory ?? ['git status', 'pnpm test'],
    commandRuns: [],
    cwd: options.cwd ?? '/fixtures/project',
    eventSource,
    paneId: options.paneId ?? 'pane-1',
    sessionId: options.sessionId ?? 'session-1',
  });
  useEffect(() => onState(state), [onState, state]);
  return null;
}

describe('useTerminalCommandAutocomplete', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('clears an active suggestion when a valid command starts', async () => {
    const eventSource = new EventTarget();
    const host = document.createElement('div');
    const root = createRoot(host);
    let state: AutocompleteState = { autocompleteSuggestion: null };

    await renderProbe(root, eventSource, (next) => {
      state = next;
    });
    await dispatchAutocompleteEvent(eventSource, 'tp-terminal-command-draft-change', {
      value: 'pnpm t',
    });
    await advanceAutocompleteTimer();
    expect(state.autocompleteSuggestion).toBe('pnpm test');

    await dispatchAutocompleteEvent(eventSource, 'tp-terminal-command-started', {
      command: 'pnpm test',
    });
    expect(state.autocompleteSuggestion).toBe('pnpm test');

    await dispatchAutocompleteEvent(eventSource, 'tp-terminal-command-started', {
      clientEventId: 'run-1',
      command: 'pnpm test',
      paneId: 'pane-1',
      sessionId: 'session-1',
      startedAtMs: 100,
    });
    expect(state.autocompleteSuggestion).toBeNull();

    act(() => root.unmount());
  });

  it('uses the latest candidates when inputs change before the throttle expires', async () => {
    const eventSource = new EventTarget();
    const addEventListener = vi.spyOn(eventSource, 'addEventListener');
    const removeEventListener = vi.spyOn(eventSource, 'removeEventListener');
    const host = document.createElement('div');
    const root = createRoot(host);
    let state: AutocompleteState = { autocompleteSuggestion: null };
    const onState = (next: AutocompleteState): void => {
      state = next;
    };

    await renderProbe(root, eventSource, onState, {
      commandHistory: ['pnpm test'],
    });
    expect(addEventListener).toHaveBeenCalledTimes(4);
    await dispatchAutocompleteEvent(eventSource, 'tp-terminal-command-draft-change', {
      value: 'pnpm t',
    });
    await renderProbe(root, eventSource, onState, {
      commandHistory: ['pnpm typecheck'],
    });
    expect(addEventListener).toHaveBeenCalledTimes(4);
    expect(removeEventListener).not.toHaveBeenCalled();
    await advanceAutocompleteTimer();

    expect(state.autocompleteSuggestion).toBe('pnpm typecheck');
    act(() => root.unmount());
    expect(removeEventListener).toHaveBeenCalledTimes(4);
  });

  it('does not leak a pending draft across command dock event sources', async () => {
    const firstSource = new EventTarget();
    const secondSource = new EventTarget();
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    const host = document.createElement('div');
    const root = createRoot(host);
    let state: AutocompleteState = { autocompleteSuggestion: null };
    const onState = (next: AutocompleteState): void => {
      state = next;
    };

    await renderProbe(root, firstSource, onState);
    await dispatchAutocompleteEvent(firstSource, 'tp-terminal-command-draft-change', {
      value: 'pnpm t',
    });
    await renderProbe(root, secondSource, onState);
    expect(clearTimeout).toHaveBeenCalled();
    await advanceAutocompleteTimer();
    expect(state.autocompleteSuggestion).toBeNull();

    await dispatchAutocompleteEvent(secondSource, 'tp-terminal-command-draft-change', {
      value: 'git s',
    });
    await advanceAutocompleteTimer();
    expect(state.autocompleteSuggestion).toBe('git status');

    act(() => root.unmount());
  });

  it('keeps accepted and dismissed drafts from resurfacing', async () => {
    const eventSource = new EventTarget();
    const host = document.createElement('div');
    const root = createRoot(host);
    let state: AutocompleteState = { autocompleteSuggestion: null };

    await renderProbe(root, eventSource, (next) => {
      state = next;
    });
    await dispatchAutocompleteEvent(eventSource, 'tp-terminal-command-draft-change', {
      value: 'git s',
    });
    await advanceAutocompleteTimer();
    expect(state.autocompleteSuggestion).toBe('git status');

    await dispatchAutocompleteEvent(eventSource, 'tp-terminal-command-autocomplete-dismiss', {
      draft: 'git s',
    });
    await advanceAutocompleteTimer();
    expect(state.autocompleteSuggestion).toBeNull();

    await dispatchAutocompleteEvent(eventSource, 'tp-terminal-command-autocomplete-accept', {
      value: 'git status',
    });
    await advanceAutocompleteTimer();
    expect(state.autocompleteSuggestion).toBeNull();

    act(() => root.unmount());
  });
});

async function renderProbe(
  root: ReturnType<typeof createRoot>,
  eventSource: EventTarget,
  onState: (state: AutocompleteState) => void,
  options?: HookProbeOptions
): Promise<void> {
  await act(async () => {
    root.render(<HookProbe eventSource={eventSource} onState={onState} options={options} />);
    await Promise.resolve();
  });
}

async function dispatchAutocompleteEvent(
  eventSource: EventTarget,
  type: string,
  detail: Record<string, unknown>
): Promise<void> {
  await act(async () => {
    eventSource.dispatchEvent(new CustomEvent(type, { detail }));
    await Promise.resolve();
  });
}

async function advanceAutocompleteTimer(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(80);
    await Promise.resolve();
  });
}
