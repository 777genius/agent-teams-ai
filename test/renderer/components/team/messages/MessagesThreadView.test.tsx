import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MessagesThreadView } from '@renderer/components/team/messages/MessagesThreadView';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('MessagesThreadView floating footer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reserves its measured height without remounting the composer across Full Screen changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
      const changeFooterHeight = async (height: number): Promise<void> => {
        let resolveMutation!: () => void;
        let rejectMutation!: (error: Error) => void;
        const observed = new Promise<void>((resolve, reject) => {
          resolveMutation = resolve;
          rejectMutation = reject;
        });
        const observer = new MutationObserver((records) => {
          if (
            records.some(
              (record) =>
                record.type === 'attributes' &&
                record.target === footer &&
                record.attributeName === 'data-probe-height'
            ) &&
            footer.getAttribute('data-probe-height') === String(height)
          ) {
            resolveMutation();
          }
        });
        const failureTimeout = setTimeout(() => {
          rejectMutation(new Error(`Footer height mutation was not delivered: ${height}`));
        }, 2_000);
        try {
          observer.observe(footer, { attributes: true, attributeFilter: ['data-probe-height'] });
          footerHeight = height;
          footer.setAttribute('data-probe-height', String(height));
          await observed;
        } finally {
          clearTimeout(failureTimeout);
          observer.disconnect();
        }
      };
      await act(async () => {
        await changeFooterHeight(160);
      });
      const scroll = host.querySelector<HTMLElement>('[data-messages-thread-scroll]')!;
      expect(scroll.className).toContain('relative z-0');
      expect(scroll.lastElementChild?.getAttribute('style')).toBe('height: 188px;');
      expect(host.querySelector('[data-messages-thread-footer-fade]')).not.toBeNull();

      await act(async () => {
        await changeFooterHeight(240);
      });
      expect(scroll.lastElementChild?.getAttribute('style')).toBe('height: 268px;');
      expect(onFloatingFooterResize).toHaveBeenCalled();

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
