import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { TerminalCommandContextMenu } from '@features/terminal-workspace/renderer/ui/TerminalCommandContextMenu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      ({
        'terminalWorkspace.copy': 'Copy',
        'terminalWorkspace.copyCommand': 'Copy command',
        'terminalWorkspace.copyOutput': 'Copy output',
        'terminalWorkspace.terminalCommandActions': 'Terminal command actions',
      })[key] ?? key,
  }),
}));

vi.mock('@renderer/utils/platformKeys', () => ({
  shortcutLabel: (_mac: string, other: string) => other,
}));

const MENU = Object.freeze({
  blockText: 'echo context\noutput',
  commandText: 'echo context',
  outputText: 'output',
  x: 100,
  y: 120,
});

describe('TerminalCommandContextMenu', () => {
  let host: HTMLDivElement;
  let root: Root;
  let onCopy: ReturnType<typeof vi.fn<(text: string) => Promise<boolean>>>;
  let reopenPersistentMenu: (() => void) | null;

  function Harness({ outputText = MENU.outputText }: { outputText?: string }): React.JSX.Element {
    const [open, setOpen] = useState(true);
    return open ? (
      <TerminalCommandContextMenu
        menu={{
          ...MENU,
          blockText: [MENU.commandText, outputText].filter(Boolean).join('\n'),
          outputText,
        }}
        onCopy={async (text) => {
          setOpen(false);
          return onCopy(text);
        }}
        onOpenChange={setOpen}
      />
    ) : (
      <div data-testid="closed-menu" />
    );
  }

  function PersistentHarness(): React.JSX.Element {
    const [menu, setMenu] = useState(MENU);
    reopenPersistentMenu = () => {
      setMenu((currentMenu) => ({ ...currentMenu }));
    };
    return (
      <TerminalCommandContextMenu menu={menu} onCopy={onCopy} onOpenChange={() => undefined} />
    );
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onCopy = vi.fn().mockResolvedValue(true);
    reopenPersistentMenu = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
    });
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('focuses the first item and supports wraparound arrow plus Home and End navigation', async () => {
    await renderHarness();
    const copy = getRequiredButton('agent-team-terminal-command-context-copy');
    const copyCommand = getRequiredButton('agent-team-terminal-command-context-copy-command');
    const copyOutput = getRequiredButton('agent-team-terminal-command-context-copy-output');
    const menu = getRequiredMenu();
    expect(document.activeElement).toBe(menu);

    await pressKey(menu, 'ArrowDown');
    expect(document.activeElement).toBe(copy);
    await pressKey(copy, 'Tab');
    expect(document.activeElement).toBe(copy);

    await pressKey(copy, 'ArrowUp');
    expect(document.activeElement).toBe(copyOutput);
    await pressKey(copyOutput, 'Home');
    expect(document.activeElement).toBe(copy);
    await pressKey(copy, 'End');
    expect(document.activeElement).toBe(copyOutput);
    await pressKey(copyOutput, 'ArrowDown');
    expect(document.activeElement).toBe(copy);
    await pressKey(copy, 'ArrowDown');
    expect(document.activeElement).toBe(copyCommand);
  });

  it('skips disabled items and dismisses on Escape', async () => {
    const previousFocus = appendFocusTarget();
    await renderHarness('');
    const copyCommand = getRequiredButton('agent-team-terminal-command-context-copy-command');
    const copyOutput = getRequiredButton('agent-team-terminal-command-context-copy-output');
    expect(copyOutput.hasAttribute('data-disabled')).toBe(true);

    await pressKey(getRequiredMenu(), 'End');
    expect(document.activeElement).toBe(copyCommand);
    await pressKey(copyCommand, 'Escape');
    await flushDismissalAutoFocus();
    expect(
      document.querySelector('[data-testid="agent-team-terminal-command-context-menu"]')
    ).toBeNull();
    expect(document.querySelector('[data-testid="closed-menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(previousFocus);
  });

  it('restores the previous focus target after choosing a copy action', async () => {
    const previousFocus = appendFocusTarget();
    await renderHarness();

    await act(async () => {
      getRequiredButton('agent-team-terminal-command-context-copy-command').click();
      await Promise.resolve();
    });
    await flushDismissalAutoFocus();

    expect(onCopy).toHaveBeenCalledWith(MENU.commandText);
    expect(document.activeElement).toBe(previousFocus);
  });

  it('keeps pointer focus when the user dismisses outside the collision-aware popover', async () => {
    const previousFocus = appendFocusTarget();
    await renderHarness();
    const outsideTarget = appendFocusTarget();

    await act(async () => {
      outsideTarget.focus();
      outsideTarget.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="agent-team-terminal-command-context-menu"]')
    ).toBeNull();
    expect(document.activeElement).toBe(outsideTarget);
    expect(document.activeElement).not.toBe(previousFocus);
  });

  it('resets focus restoration when a dismissed mount receives a new menu snapshot', async () => {
    appendFocusTarget();
    await act(async () => {
      root.render(<PersistentHarness />);
      await Promise.resolve();
    });
    const outsideTarget = appendFocusTarget();

    await act(async () => {
      outsideTarget.focus();
      outsideTarget.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="agent-team-terminal-command-context-menu"]')
    ).toBeNull();

    const nextFocusTarget = appendFocusTarget();
    await act(async () => {
      nextFocusTarget.focus();
      reopenPersistentMenu?.();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
    });
    await pressKey(getRequiredMenu(), 'Escape');
    await flushDismissalAutoFocus();

    expect(document.activeElement).toBe(nextFocusTarget);
  });

  it('restores the deepest focused control inside a terminal command dock shadow tree', async () => {
    const { commandInput, composerShadowRoot, dock } = appendShadowFocusTarget();
    await renderHarness();

    await act(async () => {
      getRequiredButton('agent-team-terminal-command-context-copy-command').click();
      await Promise.resolve();
    });
    await flushDismissalAutoFocus();

    expect(document.activeElement).toBe(dock);
    expect(composerShadowRoot.activeElement).toBe(commandInput);
  });

  it('renders platform-aware shortcut labels', async () => {
    await renderHarness();

    expect(getRequiredButton('agent-team-terminal-command-context-copy').textContent).toContain(
      'Ctrl+C'
    );
    expect(
      getRequiredButton('agent-team-terminal-command-context-copy-command').textContent
    ).toContain('Shift+Ctrl+C');
    expect(
      getRequiredButton('agent-team-terminal-command-context-copy-output').textContent
    ).toContain('Alt+Shift+Ctrl+C');
  });

  async function renderHarness(outputText?: string): Promise<void> {
    await act(async () => {
      root.render(<Harness outputText={outputText} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function getRequiredButton(testId: string): HTMLElement {
  const item = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!item) {
    throw new Error(`Missing button: ${testId}`);
  }
  return item;
}

function getRequiredMenu(): HTMLElement {
  const menu = document.querySelector<HTMLElement>(
    '[data-testid="agent-team-terminal-command-context-menu"]'
  );
  if (!menu) {
    throw new Error('Missing terminal command context menu');
  }
  return menu;
}

function appendFocusTarget(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  return input;
}

function appendShadowFocusTarget(): {
  commandInput: HTMLTextAreaElement;
  composerShadowRoot: ShadowRoot;
  dock: HTMLElement;
} {
  const dock = document.createElement('tp-terminal-command-dock');
  const dockShadowRoot = dock.attachShadow({ mode: 'open' });
  const composer = document.createElement('tp-terminal-command-composer');
  const composerShadowRoot = composer.attachShadow({ mode: 'open' });
  const commandInput = document.createElement('textarea');
  composerShadowRoot.appendChild(commandInput);
  dockShadowRoot.appendChild(composer);
  document.body.appendChild(dock);
  commandInput.focus();
  return { commandInput, composerShadowRoot, dock };
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

async function flushDismissalAutoFocus(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}
