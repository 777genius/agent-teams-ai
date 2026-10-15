import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RowMenuOwner } from '../../../src/features/task-folders/renderer/ui/TreeRowMenu';

vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('tree row menu focus lifecycle', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
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
      let frame = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frame += 1;
        callback(frame);
        return frame;
      });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      await act(async () =>
        root.render(
          <RowMenuOwner id="row">
            {({ deferAction, onCloseAutoFocus }) => (
              <button
                type="button"
                onClick={() => {
                  deferAction(run, restoreFocus);
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

      expect(run).toHaveBeenCalledOnce();
    }
  );
});
