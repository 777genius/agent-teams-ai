import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

const storeState = {
  pendingApprovals: [] as Array<{ toolName: string; receivedAt: string }>,
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

import { PendingRepliesBlock } from '@renderer/components/team/activity/PendingRepliesBlock';

const member: ResolvedTeamMember = {
  name: 'alice',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'reviewer',
  role: 'Reviewer',
  providerId: 'gemini',
  runtimeAdvisory: {
    kind: 'sdk_retrying',
    observedAt: '2026-04-09T10:00:00.000Z',
    retryUntil: '2026-04-09T10:00:45.000Z',
    retryDelayMs: 45_000,
    reasonCode: 'quota_exhausted',
    message: 'Gemini cli backend error: You have exhausted your capacity on this model.',
  },
};

describe('PendingRepliesBlock', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('shows a reason-specific retry label for pending member replies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T10:00:00.000Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(PendingRepliesBlock, {
          members: [member],
          pendingRepliesByMember: {
            alice: Date.parse('2026-04-09T09:59:00.000Z'),
          },
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Gemini quota retry');
    const retryElement = host.querySelector('[title*="Gemini quota exhausted"]');
    expect(retryElement).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
