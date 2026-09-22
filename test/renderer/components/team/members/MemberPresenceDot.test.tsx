import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemberPresenceDot } from '@renderer/components/team/members/MemberPresenceDot';

describe('MemberPresenceDot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('uses a shared wall-clock phase for pulse animations', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    vi.spyOn(performance, 'now').mockReturnValue(725);

    await act(async () => {
      root.render(
        React.createElement(MemberPresenceDot, {
          className: 'size-2.5 bg-emerald-400 animate-pulse',
          label: 'ready',
        })
      );
      await Promise.resolve();
    });

    const dot = host.querySelector('span') as HTMLSpanElement | null;
    expect(dot?.style.animationDelay).toBe('-725ms');
    expect(dot?.style.animationDuration).toBe('2000ms');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not add animation timing to static status dots', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberPresenceDot, {
          className: 'size-2.5 bg-zinc-600',
          label: 'offline',
        })
      );
      await Promise.resolve();
    });

    const dot = host.querySelector('span') as HTMLSpanElement | null;
    expect(dot?.style.animationDelay).toBe('');
    expect(dot?.style.animationDuration).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
