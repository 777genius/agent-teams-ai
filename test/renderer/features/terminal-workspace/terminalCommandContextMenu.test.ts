import {
  copyTerminalCommandContextText,
  resolveTerminalCommandContextMenuSnapshot,
} from '@features/terminal-workspace/renderer/adapters/terminalCommandContextMenu';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('terminal command context menu adapter', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    vi.restoreAllMocks();
  });

  it('captures an immutable command and output snapshot through a composed DOM path', () => {
    const entry = document.createElement('section');
    entry.className = 'history-entry';
    entry.innerHTML = `
      <div part="history-entry-command">
        <span part="history-entry-command-text">echo CONTEXT</span>
      </div>
      <div part="history-entry-output">
        <span part="history-entry-output-text">CONTEXT_OUTPUT  \nsecond line\t</span>
      </div>
    `;
    const target = entry.querySelector<HTMLElement>('[part~="history-entry-command-text"]');
    if (!target) {
      throw new Error('Expected command target fixture');
    }
    const event = createTargetedMouseEvent(target, 120, 140, [target, entry]);

    const snapshot = resolveTerminalCommandContextMenuSnapshot(event);
    expect(snapshot).toEqual({
      blockText: 'echo CONTEXT\nCONTEXT_OUTPUT\nsecond line',
      commandText: 'echo CONTEXT',
      outputText: 'CONTEXT_OUTPUT\nsecond line',
      x: 120,
      y: 140,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);

    target.textContent = 'mutated after opening';
    expect(snapshot?.commandText).toBe('echo CONTEXT');
  });

  it('ignores unrelated targets and entries without a command', () => {
    const unrelated = document.createElement('div');
    expect(
      resolveTerminalCommandContextMenuSnapshot(
        createTargetedMouseEvent(unrelated, 20, 20, [unrelated])
      )
    ).toBeNull();

    const outputOnlyEntry = document.createElement('section');
    outputOnlyEntry.setAttribute('part', 'history-entry');
    outputOnlyEntry.innerHTML = '<span part="history-entry-output-text">output</span>';
    expect(
      resolveTerminalCommandContextMenuSnapshot(
        createTargetedMouseEvent(outputOnlyEntry, 30, 40, [outputOnlyEntry])
      )
    ).toBeNull();
  });

  it('returns true when the modern Clipboard API succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await expect(copyTerminalCommandContextText('copy me')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('copy me');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back after Clipboard API rejection and always removes its textarea', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await expect(copyTerminalCommandContextText('fallback text')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it.each([
    ['returns false', vi.fn().mockReturnValue(false)],
    [
      'throws',
      vi.fn().mockImplementation(() => {
        throw new Error('blocked');
      }),
    ],
  ])('never rejects when execCommand %s', async (_label, execCommand) => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await expect(copyTerminalCommandContextText('uncopyable')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});

function createTargetedMouseEvent(
  target: HTMLElement,
  clientX: number,
  clientY: number,
  composedPath: EventTarget[]
): MouseEvent {
  const event = new MouseEvent('contextmenu', { clientX, clientY });
  Object.defineProperties(event, {
    composedPath: { value: () => composedPath },
    target: { value: target },
  });
  return event;
}
