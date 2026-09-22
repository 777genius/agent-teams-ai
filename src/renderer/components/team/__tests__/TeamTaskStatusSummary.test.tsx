import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskStatusSummary } from '../TeamTaskStatusSummary';

function renderSummary(element: React.ReactElement): {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(element);
  });

  return { host, root };
}

describe('TeamTaskStatusSummary', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders task status counters with team card labels', () => {
    const { host, root } = renderSummary(
      <TeamTaskStatusSummary
        showProgress={false}
        counts={{ inProgress: 2, pending: 2, completed: 1 }}
      />
    );

    expect(host.textContent).toContain('2 in_progress');
    expect(host.textContent).toContain('2 pending');
    expect(host.textContent).toContain('1 completed');

    act(() => {
      root.unmount();
    });
  });

  it('hides zero counters when progress is disabled', () => {
    const { host, root } = renderSummary(
      <TeamTaskStatusSummary
        showProgress={false}
        counts={{ inProgress: 0, pending: 0, completed: 0 }}
      />
    );

    expect(host.textContent).toBe('');

    act(() => {
      root.unmount();
    });
  });
});
