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
    await act(async () => {
      footer.setAttribute('data-probe-height', '160');
      await Promise.resolve();
    });
    const scroll = host.querySelector<HTMLElement>('[data-messages-thread-scroll]')!;
    expect(scroll.lastElementChild?.getAttribute('style')).toBe('height: 188px;');
    expect(host.querySelector('[data-messages-thread-footer-fade]')).not.toBeNull();

    footerHeight = 240;
    await act(async () => {
      footer.setAttribute('data-probe-height', '240');
      await Promise.resolve();
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
    expect(scroll.lastElementChild?.getAttribute('style')).not.toBe('height: 268px;');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
