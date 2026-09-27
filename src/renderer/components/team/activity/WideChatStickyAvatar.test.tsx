import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WideChatStickyAvatar } from './WideChatStickyAvatar';

import type { TimelineRow } from './timelineRows';
import type { InboxMessage } from '@shared/types';

const messageRow = (key: string, from: string): TimelineRow => ({
  kind: 'message-row',
  key,
  itemIndex: 0,
  message: { from, to: 'user', text: 'Visible message', timestamp: 'now' } as InboxMessage,
});

describe('WideChatStickyAvatar', () => {
  const callbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    callbacks.length = 0;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps one avatar across virtualized continuation rows and changes it at the next sender', async () => {
    const scrollElement = document.createElement('div');
    const timeline = document.createElement('div');
    const mount = document.createElement('div');
    scrollElement.append(timeline);
    timeline.append(mount);
    document.body.append(scrollElement);
    scrollElement.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect;

    const positions = new Map<number, { top: number; bottom: number }>([
      [1, { top: -30, bottom: 80 }],
      [2, { top: 80, bottom: 180 }],
    ]);
    for (const index of [1, 2]) {
      const row = document.createElement('div');
      row.dataset.timelineRowKey = `row-${index}`;
      row.dataset.index = String(index);
      row.getBoundingClientRect = () => positions.get(index) as DOMRect;
      timeline.append(row);
    }
    const rows = [
      messageRow('first', 'atlas'),
      messageRow('second', 'atlas'),
      messageRow('third', 'nova'),
    ];
    const root = createRoot(mount);
    const flushFrame = async (): Promise<void> => {
      await act(async () => callbacks.splice(0).forEach((callback) => callback(0)));
    };

    try {
      await act(async () => {
        root.render(
          <WideChatStickyAvatar
            rows={rows}
            continuesPreviousAuthor={[false, true, false]}
            teamName="test-team"
            scrollElement={scrollElement}
            rootRef={{ current: timeline }}
          />
        );
      });
      await flushFrame();
      expect(mount.querySelectorAll('img')).toHaveLength(1);
      const atlasSrc = mount.querySelector('img')?.src;

      positions.set(1, { top: -150, bottom: -20 });
      positions.set(2, { top: 12, bottom: 112 });
      await act(async () => scrollElement.dispatchEvent(new Event('scroll')));
      await flushFrame();
      expect(mount.querySelector('img')).toBeNull();

      positions.set(2, { top: -20, bottom: 80 });
      await act(async () => scrollElement.dispatchEvent(new Event('scroll')));
      await flushFrame();
      expect(mount.querySelectorAll('img')).toHaveLength(1);
      expect(mount.querySelector('img')?.src).not.toBe(atlasSrc);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
