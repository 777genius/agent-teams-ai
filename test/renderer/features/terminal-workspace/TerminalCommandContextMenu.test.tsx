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

  function Harness({ outputText = MENU.outputText }: { outputText?: string }): React.JSX.Element {
    const [open, setOpen] = useState(true);
    return open ? (
      <TerminalCommandContextMenu
        menu={{
          ...MENU,
          blockText: [MENU.commandText, outputText].filter(Boolean).join('\n'),
          outputText,
        }}
        onCopy={onCopy}
        onOpenChange={setOpen}
      />
    ) : (
      <div data-testid="closed-menu" />
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
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
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
    await renderHarness('');
    const copy = getRequiredButton('agent-team-terminal-command-context-copy');
    const copyCommand = getRequiredButton('agent-team-terminal-command-context-copy-command');
    const copyOutput = getRequiredButton('agent-team-terminal-command-context-copy-output');
    expect(copyOutput.disabled).toBe(true);

    await pressKey(copy, 'End');
    expect(document.activeElement).toBe(copyCommand);
    await pressKey(copyCommand, 'Escape');
    expect(
      document.querySelector('[data-testid="agent-team-terminal-command-context-menu"]')
    ).toBeNull();
    expect(document.querySelector('[data-testid="closed-menu"]')).not.toBeNull();
  });

  it('dismisses when the user interacts outside the collision-aware popover', async () => {
    await renderHarness();

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="agent-team-terminal-command-context-menu"]')
    ).toBeNull();
  });

  async function renderHarness(outputText?: string): Promise<void> {
    await act(async () => {
      root.render(<Harness outputText={outputText} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function getRequiredButton(testId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) {
    throw new Error(`Missing button: ${testId}`);
  }
  return button;
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
    await Promise.resolve();
  });
}
