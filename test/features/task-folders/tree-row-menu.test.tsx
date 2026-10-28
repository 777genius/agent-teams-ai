import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RowMenuOwner } from '../../../src/features/task-folders/renderer/ui/TreeRowMenu';

const menuOpenChange = vi.hoisted(() => ({
  current: undefined as ((open: boolean) => void) | undefined,
}));

vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange(open: boolean): void;
  }) => {
    menuOpenChange.current = onOpenChange;
    return <>{children}</>;
  },
}));

interface QueuedFrame {
  id: number;
  callback: FrameRequestCallback;
  cancelled: boolean;
}

function queueAnimationFrames() {
  const frames: QueuedFrame[] = [];
  let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextId += 1;
    frames.push({ id: nextId, callback, cancelled: false });
    return nextId;
  });
  const cancel = vi.fn<(id: number) => void>((id) => {
    const queued = frames.find((candidate) => candidate.id === id);
    if (queued) queued.cancelled = true;
  });
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    cancel,
    flush: () => {
      for (const queued of frames.splice(0)) {
        if (!queued.cancelled) queued.callback(queued.id);
      }
    },
  };
}

describe('tree row menu focus lifecycle', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mounted: boolean;

  const unmount = async (): Promise<void> => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mounted = true;
  });

  afterEach(async () => {
    await unmount();
    host.remove();
    menuOpenChange.current = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { restoreFocus: true, defaultPrevented: false },
    { restoreFocus: false, defaultPrevented: true },
  ])(
    'defers the action and %s focus restoration after menu close',
    async ({ restoreFocus, defaultPrevented }) => {
      const run = vi.fn();
      const animation = queueAnimationFrames();

      await act(async () =>
        root.render(
          <RowMenuOwner id="row">
            {({ deferAction, onCloseAutoFocus }) => (
              <button
                type="button"
                onClick={() => {
                  menuOpenChange.current?.(true);
                  deferAction(run, restoreFocus);
                  menuOpenChange.current?.(false);
                  const event = new Event('close', { cancelable: true });
                  onCloseAutoFocus(event);
                  expect(event.defaultPrevented).toBe(defaultPrevented);
                }}
              >
                close
              </button>
            )}
          </RowMenuOwner>
        )
      );

      await act(async () => host.querySelector('button')!.click());
      await act(async () => animation.flush());

      expect(run).toHaveBeenCalledOnce();
    }
  );

  it('runs one selected action per activation and accepts a later genuine activation', async () => {
    const duplicate = vi.fn();
    const genuine = vi.fn();
    const animation = queueAnimationFrames();

    await act(async () =>
      root.render(
        <RowMenuOwner id="row">
          {({ deferAction, onCloseAutoFocus }) => {
            const selectAndClose = (run: () => void): void => {
              deferAction(run, true);
              menuOpenChange.current?.(false);
              onCloseAutoFocus(new Event('close', { cancelable: true }));
            };
            return (
              <>
                <button
                  type="button"
                  onClick={() => {
                    menuOpenChange.current?.(true);
                    selectAndClose(duplicate);
                    selectAndClose(duplicate);
                  }}
                >
                  duplicate activation callbacks
                </button>
                <button
                  type="button"
                  onClick={() => {
                    menuOpenChange.current?.(true);
                    selectAndClose(genuine);
                  }}
                >
                  later activation
                </button>
              </>
            );
          }}
        </RowMenuOwner>
      )
    );

    const [duplicateButton, genuineButton] = Array.from(host.querySelectorAll('button'));
    await act(async () => duplicateButton.click());
    await act(async () => animation.flush());
    await act(async () => genuineButton.click());
    await act(async () => animation.flush());

    expect(duplicate).toHaveBeenCalledOnce();
    expect(genuine).toHaveBeenCalledOnce();
  });

  it('cancels every queued action when the row owner unmounts', async () => {
    const run = vi.fn();
    const animation = queueAnimationFrames();

    await act(async () =>
      root.render(
        <RowMenuOwner id="row">
          {({ deferAction, onCloseAutoFocus }) => {
            const activate = (): void => {
              menuOpenChange.current?.(true);
              deferAction(run, true);
              menuOpenChange.current?.(false);
              onCloseAutoFocus(new Event('close', { cancelable: true }));
            };
            return (
              <button
                type="button"
                onClick={() => {
                  activate();
                  activate();
                }}
              >
                activate twice
              </button>
            );
          }}
        </RowMenuOwner>
      )
    );

    await act(async () => host.querySelector('button')!.click());
    await unmount();

    expect(animation.cancel).toHaveBeenCalledTimes(2);
    animation.flush();
    expect(run).not.toHaveBeenCalled();
  });
});
