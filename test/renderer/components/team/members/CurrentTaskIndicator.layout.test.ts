import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CurrentTaskIndicator } from '@renderer/components/team/members/CurrentTaskIndicator';

import type { TeamTaskWithKanban } from '@shared/types';

const task: TeamTaskWithKanban = {
  id: 'task-1',
  displayId: '9d1915a7',
  subject: 'Полный аудит актуальности документации и связанных onboarding заметок',
  status: 'in_progress',
} as unknown as TeamTaskWithKanban;

describe('CurrentTaskIndicator', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses all available width for the task pill without early subject truncation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(CurrentTaskIndicator, {
          task,
          borderColor: '#3b82f6',
        })
      );
      await Promise.resolve();
    });

    const wrapper = host.firstElementChild as HTMLElement | null;
    const button = host.querySelector('button');

    expect(wrapper?.className).toContain('flex-1');
    expect(button?.className).toContain('flex-1');
    expect(button?.className).toContain('text-left');
    expect(button?.textContent).toContain(task.subject);
    expect(button?.style.border).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('still supports an explicit subject ceiling when a compact caller requests it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(CurrentTaskIndicator, {
          task,
          borderColor: '#3b82f6',
          maxSubjectLength: 12,
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('button');
    expect(button?.textContent).toContain('Полный аудит…');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('syncs the spinner animation phase across independently mounted indicators', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(CurrentTaskIndicator, {
          task,
          borderColor: '#3b82f6',
        })
      );
      await Promise.resolve();
    });

    const spinner = host.querySelector('svg.animate-spin') as SVGElement | null;
    expect(spinner?.style.animationDelay).toMatch(/^-?\d+(\.\d+)?ms$/);
    expect(spinner?.style.animationDuration).toBe('1000ms');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('pauses the spinner when the activity timer is not running', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(CurrentTaskIndicator, {
          task,
          borderColor: '#3b82f6',
          isTimerRunning: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('svg.animate-spin')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
