import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from '@renderer/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedTerminal } from './EmbeddedTerminal';

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: vi.fn(),
    terminal: {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    },
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    getSelection: vi.fn(() => ''),
    write: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
  })),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

let frameCallbacks: Map<number, FrameRequestCallback>;
let nextFrameId: number;

function flushFrames(): void {
  const callbacks = Array.from(frameCallbacks.values());
  frameCallbacks.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('EmbeddedTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    frameCallbacks = new Map();
    nextFrameId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        frameCallbacks.set(id, callback);
        return id;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        frameCallbacks.delete(id);
      })
    );
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
      }))
    );

    vi.mocked(api.terminal.spawn).mockResolvedValue('pty-1');
    vi.mocked(api.terminal.onData).mockReturnValue(() => undefined);
    vi.mocked(api.terminal.onExit).mockReturnValue(() => undefined);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not spawn twice during React StrictMode effect replay', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <React.StrictMode>
          <EmbeddedTerminal command="/bin/runtime" args={['auth', 'login']} />
        </React.StrictMode>
      );
      await flushReact();
    });

    expect(api.terminal.spawn).not.toHaveBeenCalled();

    await act(async () => {
      flushFrames();
      await flushReact();
    });

    expect(api.terminal.spawn).toHaveBeenCalledTimes(1);
    expect(api.terminal.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/runtime',
        args: ['auth', 'login'],
      })
    );

    await act(async () => {
      root.unmount();
      await flushReact();
    });
  });

  it('kills a PTY that resolves after the terminal unmounts', async () => {
    let resolveSpawn: (id: string) => void = () => {};
    vi.mocked(api.terminal.spawn).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSpawn = resolve;
      })
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<EmbeddedTerminal command="/bin/runtime" args={['auth', 'login']} />);
      await flushReact();
    });

    await act(async () => {
      flushFrames();
      await flushReact();
    });

    expect(api.terminal.spawn).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await flushReact();
    });

    await act(async () => {
      resolveSpawn('late-pty');
      await flushReact();
    });

    expect(api.terminal.kill).toHaveBeenCalledWith('late-pty');
  });
});
