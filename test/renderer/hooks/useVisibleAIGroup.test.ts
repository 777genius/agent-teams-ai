import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useVisibleAIGroup } from '../../../src/renderer/hooks/useVisibleAIGroup';

class FakeIntersectionObserver {
  constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

describe('useVisibleAIGroup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('uses provided rootRef as IntersectionObserver root', async () => {
    const observerSpy = vi.fn(
      (cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) =>
        new FakeIntersectionObserver(cb, opts)
    );

    vi.stubGlobal('IntersectionObserver', observerSpy as unknown as typeof IntersectionObserver);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const rootEl = document.createElement('div');

    function Harness(): React.JSX.Element {
      const rootRef = React.useRef<HTMLElement>(rootEl);
      useVisibleAIGroup({ onVisibleChange: () => undefined, rootRef });
      return React.createElement('div');
    }

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(observerSpy).toHaveBeenCalled();
    const lastCall = observerSpy.mock.calls[observerSpy.mock.calls.length - 1];
    expect(lastCall?.[1]?.root).toBe(rootEl);

    root.unmount();
  });
});
