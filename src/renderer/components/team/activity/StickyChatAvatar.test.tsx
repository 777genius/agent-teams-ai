import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StickyChatAvatar } from './StickyChatAvatar';

import type { TimelineRow } from './timelineRows';

const rows: TimelineRow[] = [
  {
    kind: 'message-row',
    key: 'first',
    itemIndex: 0,
    message: { from: 'lead', to: 'atlas', text: 'First', timestamp: '2026-09-27', read: true },
  },
  {
    kind: 'message-row',
    key: 'second',
    itemIndex: 1,
    message: { from: 'lead', to: 'user', text: 'Second', timestamp: '2026-09-27', read: true },
  },
];

function rect(top: number, bottom: number, left = 40): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom,
    left,
    right: left + 400,
    width: 400,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('StickyChatAvatar', () => {
  let frames: FrameRequestCallback[];
  let resizeCallbacks: ResizeObserverCallback[];
  let observedElements: Element[];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    frames = [];
    resizeCallbacks = [];
    observedElements = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe(element: Element): void {
          observedElements.push(element);
        }
        disconnect(): void {}
      }
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('hides a native avatar only while it overlaps the composer-boundary clone', async () => {
    const layout = document.createElement('div');
    layout.dataset.messagesThreadLayout = 'wide';
    const scrollElement = document.createElement('div');
    const warning = document.createElement('div');
    const timeline = document.createElement('div');
    const footer = document.createElement('div');
    footer.dataset.messagesThreadFooter = 'true';
    scrollElement.append(warning, timeline);
    layout.append(scrollElement, footer);
    document.body.appendChild(layout);

    const first = document.createElement('div');
    first.dataset.timelineRowIndex = '0';
    const firstArticle = document.createElement('article');
    firstArticle.className = 'wide-chat-message';
    firstArticle.dataset.wideAgent = 'true';
    first.appendChild(firstArticle);
    const second = document.createElement('div');
    second.dataset.timelineRowIndex = '1';
    const secondArticle = firstArticle.cloneNode() as HTMLElement;
    const sender = document.createElement('span');
    sender.dataset.chatSender = 'true';
    const nativeAvatar = document.createElement('img');
    sender.appendChild(nativeAvatar);
    secondArticle.appendChild(sender);
    second.appendChild(secondArticle);
    timeline.append(first, second);

    vi.spyOn(scrollElement, 'getBoundingClientRect').mockReturnValue(rect(0, 300));
    vi.spyOn(footer, 'getBoundingClientRect').mockReturnValue(rect(280, 400));
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect(100, 220));
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect(220, 320));
    vi.spyOn(firstArticle, 'getBoundingClientRect').mockReturnValue(rect(100, 220));
    vi.spyOn(secondArticle, 'getBoundingClientRect').mockReturnValue(rect(220, 320));
    const avatarRect = vi.spyOn(nativeAvatar, 'getBoundingClientRect');
    avatarRect.mockReturnValue(rect(260, 292));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <StickyChatAvatar
          enabled
          rows={rows}
          continuesPreviousAvatarAuthor={[false, true]}
          scrollElement={scrollElement}
          timelineRoot={{ current: timeline }}
        />
      );
    });
    await act(async () => {
      frames.splice(0).forEach((callback) => callback(0));
    });

    expect(document.querySelector('[data-sticky-chat-avatar="lead"]')).not.toBeNull();
    expect(nativeAvatar.dataset.stickyNativeHidden).toBe('true');
    expect(observedElements).toContain(warning);

    avatarRect.mockReturnValue(rect(230, 262));
    await act(async () => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      frames.splice(0).forEach((callback) => callback(0));
    });
    expect(document.querySelector('[data-sticky-chat-avatar]')).toBeNull();
    expect(nativeAvatar.dataset.stickyNativeHidden).toBeUndefined();

    avatarRect.mockReturnValue(rect(260, 292));
    await act(async () => {
      scrollElement.dispatchEvent(new Event('scroll'));
      frames.splice(0).forEach((callback) => callback(0));
    });
    expect(document.querySelector('[data-sticky-chat-avatar="lead"]')).not.toBeNull();
    await act(async () => {
      root.render(
        <StickyChatAvatar
          enabled={false}
          rows={rows}
          continuesPreviousAvatarAuthor={[false, true]}
          scrollElement={scrollElement}
          timelineRoot={{ current: timeline }}
        />
      );
    });
    expect(document.querySelector('[data-sticky-chat-avatar]')).toBeNull();
    expect(nativeAvatar.dataset.stickyNativeHidden).toBeUndefined();

    await act(async () => root.unmount());
  });

  it('pins one avatar at the top through a sender group and changes it with the sender', async () => {
    const scrollElement = document.createElement('div');
    const timeline = document.createElement('div');
    const host = document.createElement('div');
    scrollElement.append(timeline);
    document.body.append(scrollElement, host);
    vi.spyOn(scrollElement, 'getBoundingClientRect').mockReturnValue(rect(0, 400));
    const positions = [
      { top: -20, bottom: 100 },
      { top: 100, bottom: 220 },
      { top: 220, bottom: 330 },
    ];
    const nativeAvatars: HTMLImageElement[] = [];
    for (let index = 0; index < 3; index += 1) {
      const row = document.createElement('div');
      row.dataset.timelineRowIndex = String(index);
      const article = document.createElement('article');
      article.className = 'wide-chat-message';
      article.dataset.wideAgent = 'true';
      const sender = document.createElement('span');
      sender.dataset.chatSender = 'true';
      const nativeAvatar = document.createElement('img');
      nativeAvatars.push(nativeAvatar);
      vi.spyOn(nativeAvatar, 'getBoundingClientRect').mockImplementation(() =>
        rect(positions[index].top, positions[index].top + 32)
      );
      sender.append(nativeAvatar);
      article.append(sender);
      row.append(article);
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() =>
        rect(positions[index].top, positions[index].bottom)
      );
      vi.spyOn(article, 'getBoundingClientRect').mockImplementation(() =>
        rect(positions[index].top, positions[index].bottom)
      );
      timeline.append(row);
    }
    const topRows: TimelineRow[] = [
      ...rows,
      {
        kind: 'message-row',
        key: 'third',
        itemIndex: 2,
        message: { from: 'nova', to: 'user', text: 'Third', timestamp: '2026-09-27', read: true },
      },
    ];
    const root = createRoot(host);
    const flush = async (): Promise<void> => {
      await act(async () => frames.splice(0).forEach((callback) => callback(0)));
    };
    try {
      await act(async () => {
        root.render(
          <StickyChatAvatar
            enabled
            rows={topRows}
            continuesPreviousAvatarAuthor={[false, true, false]}
            scrollElement={scrollElement}
            timelineRoot={{ current: timeline }}
          />
        );
      });
      await flush();
      expect(document.querySelectorAll('[data-sticky-chat-avatar="lead"]')).toHaveLength(1);
      expect(nativeAvatars[1].dataset.stickyNativeHidden).toBe('true');

      positions[0] = { top: -150, bottom: -30 };
      positions[1] = { top: 12, bottom: 122 };
      await act(async () => scrollElement.dispatchEvent(new Event('scroll')));
      await flush();
      expect(document.querySelector('[data-sticky-chat-avatar]')).toBeNull();
      expect(nativeAvatars[1].dataset.stickyNativeHidden).toBeUndefined();

      positions[1] = { top: -150, bottom: -30 };
      positions[2] = { top: -20, bottom: 90 };
      await act(async () => scrollElement.dispatchEvent(new Event('scroll')));
      await flush();
      expect(document.querySelectorAll('[data-sticky-chat-avatar="nova"]')).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
