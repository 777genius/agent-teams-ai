import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useTerminalCommandContextMenu } from '@features/terminal-workspace/renderer/hooks/useTerminalCommandContextMenu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ContextMenuControls = ReturnType<typeof useTerminalCommandContextMenu>;

describe('useTerminalCommandContextMenu', () => {
  let controls: ContextMenuControls | null;
  let host: HTMLDivElement;
  let root: Root;

  function Harness({
    command,
    contextKey,
    copyText,
  }: {
    command: string;
    contextKey: string;
    copyText: (text: string) => Promise<boolean>;
  }): React.JSX.Element {
    controls = useTerminalCommandContextMenu({ contextKey, copyText });
    return (
      <div data-testid="context-root" onContextMenuCapture={controls.handleContextMenuCapture}>
        <button data-testid="unrelated-target" type="button">
          unrelated
        </button>
        <section className="history-entry" data-testid="history-entry">
          <span part="history-entry-command-text">{command}</span>
          <span part="history-entry-output-text">output</span>
        </section>
      </div>
    );
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    controls = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves unrelated right-click semantics and only cancels command targets', async () => {
    const copyText = vi.fn().mockResolvedValue(true);
    await renderHarness('echo one', 'team/session/pane/view', copyText);
    const documentListener = vi.fn();
    document.addEventListener('contextmenu', documentListener);

    const unrelatedEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    const stopPropagation = vi.spyOn(unrelatedEvent, 'stopPropagation');
    await act(async () => {
      getRequiredElement('unrelated-target').dispatchEvent(unrelatedEvent);
      await Promise.resolve();
    });

    expect(unrelatedEvent.defaultPrevented).toBe(false);
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(documentListener).toHaveBeenCalledOnce();
    expect(controls?.menu).toBeNull();

    const commandEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 75,
      clientY: 95,
    });
    const stopCommandPropagation = vi.spyOn(commandEvent, 'stopPropagation');
    await act(async () => {
      getRequiredElement('history-entry').dispatchEvent(commandEvent);
      await Promise.resolve();
    });

    expect(commandEvent.defaultPrevented).toBe(true);
    expect(stopCommandPropagation).toHaveBeenCalledOnce();
    expect(controls?.menu).toMatchObject({
      commandText: 'echo one',
      outputText: 'output',
      x: 75,
      y: 95,
    });
    document.removeEventListener('contextmenu', documentListener);
  });

  it('closes whenever the team, session, pane, or settings context key changes', async () => {
    const copyText = vi.fn().mockResolvedValue(true);
    await renderHarness('echo one', 'team-a/session-1/pane-1/terminal', copyText);
    await openHistoryMenu();
    expect(controls?.menu?.commandText).toBe('echo one');

    await renderHarness('echo one', 'team-a/session-1/pane-2/settings', copyText);
    expect(controls?.menu).toBeNull();
  });

  it('closes before awaiting copy and an old request cannot close a newer menu', async () => {
    let resolveCopy: (copied: boolean) => void = () => {
      throw new Error('Copy promise was not created');
    };
    const copyText = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCopy = resolve;
        })
    );
    await renderHarness('echo first', 'stable-context', copyText);
    await openHistoryMenu();

    let pendingCopy: Promise<boolean> | null = null;
    await act(async () => {
      pendingCopy = controls?.copyMenuText('echo first') ?? null;
      await Promise.resolve();
    });
    expect(controls?.menu).toBeNull();

    await renderHarness('echo second', 'stable-context', copyText);
    await openHistoryMenu();
    expect(controls?.menu?.commandText).toBe('echo second');

    resolveCopy(true);
    await expect(pendingCopy).resolves.toBe(true);
    expect(controls?.menu?.commandText).toBe('echo second');
  });

  it('turns a rejected copy port into a false result', async () => {
    const copyText = vi.fn().mockRejectedValue(new Error('unexpected adapter rejection'));
    await renderHarness('echo one', 'stable-context', copyText);
    await openHistoryMenu();

    let result = true;
    await act(async () => {
      result = (await controls?.copyMenuText('echo one')) ?? true;
    });
    expect(result).toBe(false);
    expect(controls?.menu).toBeNull();
  });

  async function renderHarness(
    command: string,
    contextKey: string,
    copyText: (text: string) => Promise<boolean>
  ): Promise<void> {
    await act(async () => {
      root.render(<Harness command={command} contextKey={contextKey} copyText={copyText} />);
      await Promise.resolve();
    });
  }

  async function openHistoryMenu(): Promise<void> {
    await act(async () => {
      getRequiredElement('history-entry').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        })
      );
      await Promise.resolve();
    });
  }
});

function getRequiredElement(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`Missing test element: ${testId}`);
  }
  return element;
}
