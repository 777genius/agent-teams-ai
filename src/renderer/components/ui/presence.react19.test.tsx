import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Presence } from '@radix-ui/react-presence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('Radix Presence React 19 compatibility', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not recurse when a composed child ref changes identity and returns cleanup', async () => {
    const refEvents: string[] = [];

    const Harness = (): React.JSX.Element => {
      const [tick, setTick] = useState(0);

      return (
        <div>
          <button type="button" onClick={() => setTick((value) => value + 1)}>
            rerender
          </button>
          <Presence present>
            <div
              ref={(node) => {
                refEvents.push(node ? 'node' : 'null');
                return () => {
                  refEvents.push('cleanup');
                };
              }}
            >
              tick {tick}
            </div>
          </Presence>
        </div>
      );
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Harness />);
      await flushMicrotasks();
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')?.click();
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('tick 1');
    expect(refEvents.length).toBeLessThan(10);
    expect(refEvents).toContain('cleanup');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
