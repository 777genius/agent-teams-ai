import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MessagesThreadView } from '@renderer/components/team/messages/MessagesThreadView';
import { mutationListeners } from 'happy-dom/lib/PropertySymbol.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Node as HappyDOMNode } from 'happy-dom';

describe('MessagesThreadView floating footer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reserves its measured height without remounting the composer across Full Screen changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // Happy DOM strongly retains the observer callback, but its node listener
    // holds only a WeakRef to a separate report closure. Retain that closure
    // until disconnect so GC cannot remove native mutation delivery under load.
    const NativeMutationObserver = globalThis.MutationObserver;
    class RetainedMutationObserver extends NativeMutationObserver {
      private readonly retainedReports = new Set<unknown>();
      override observe(target: Node, options?: MutationObserverInit): void {
        const node = target as unknown as HappyDOMNode;
        const previous = new Set(node[mutationListeners]);
        super.observe(target, options);
        for (const listener of node[mutationListeners]) {
          if (previous.has(listener)) continue;
          const report = listener.callback.deref();
          if (!report) throw new Error('Native mutation report callback was lost during observe');
          this.retainedReports.add(report);
        }
      }
      override disconnect(): void {
        super.disconnect();
        this.retainedReports.clear();
      }
    }
    vi.stubGlobal('MutationObserver', RetainedMutationObserver);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onFloatingFooterResize = vi.fn();
    const render = (floatingFooter: boolean): void => {
      root.render(
        <MessagesThreadView
          variant={floatingFooter ? 'wide' : 'sidebar'}
          floatingFooter={floatingFooter}
          onFloatingFooterResize={onFloatingFooterResize}
          composer={<textarea aria-label="Compose" />}
          composerStatus={<div>Status</div>}
          status={null}
          timeline={<div>Message history</div>}
          latestControl={<button type="button">Latest</button>}
          scrollRef={vi.fn()}
        />
      );
    };

    try {
      await act(async () => {
        render(false);
        await Promise.resolve();
      });
      const footer = host.querySelector<HTMLElement>('[data-messages-thread-footer]')!;
      const composer = host.querySelector('textarea');

      await act(async () => {
        render(true);
        await Promise.resolve();
      });
      expect(host.querySelector('[data-messages-thread-footer]')).toBe(footer);
      expect(host.querySelector('textarea')).toBe(composer);
      expect(footer.className).toContain('absolute');
      expect(footer.className).toContain('bg-[var(--color-surface)]');

      let footerHeight = 160;
      footer.getBoundingClientRect = () => ({ height: footerHeight }) as DOMRect;
      const scroll = host.querySelector<HTMLElement>('[data-messages-thread-scroll]')!;
      const changeFooterHeight = async (height: number, expectedReserve: string): Promise<void> => {
        await act(async () => {
          footerHeight = height;
          footer.setAttribute('data-probe-height', String(height));
        });
        await vi.waitFor(async () => {
          // The component's MutationObserver and React commit are separate async steps.
          await act(async () => {
            await Promise.resolve();
          });
          expect(scroll.lastElementChild?.getAttribute('style')).toBe(expectedReserve);
        });
      };
      await changeFooterHeight(160, 'height: 188px;');
      expect(scroll.className).toContain('relative z-0');
      expect(host.querySelector('[data-messages-thread-footer-fade]')).not.toBeNull();

      const resizeCount = onFloatingFooterResize.mock.calls.length;
      await changeFooterHeight(240, 'height: 268px;');
      expect(onFloatingFooterResize.mock.calls.length).toBeGreaterThan(resizeCount);

      await act(async () => {
        render(false);
        await Promise.resolve();
      });
      expect(host.querySelector('[data-messages-thread-footer]')).toBe(footer);
      expect(host.querySelector('textarea')).toBe(composer);
      expect(host.querySelector('[data-messages-thread-footer-fade]')).toBeNull();
      expect(scroll.className).not.toContain('relative z-0');
      expect(scroll.lastElementChild?.getAttribute('style')).not.toBe('height: 268px;');
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    }
  });
});
