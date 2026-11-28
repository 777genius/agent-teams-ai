// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { expect, it, vi } from 'vitest';

import { GroupDeliveryNotice } from './GroupDeliveryNotice';

import type { InboxMessage } from '@shared/types';

const readStatus = vi.hoisted(() => vi.fn());
const readHostStatus = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getOpenCodeRuntimeDeliveryStatus: readStatus,
      getHostMessageDeliveryStatus: readHostStatus,
    },
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (_key: string, { names }: { names: string }) => names }),
}));

it('shows only the recipient whose delivery became unconfirmed and stops checking', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  const message: InboxMessage = {
    from: 'user',
    to: 'user',
    text: 'TEST',
    read: true,
    timestamp: new Date().toISOString(),
    groupChatId: 'test-group',
    groupDeliverySummary: {
      recordedAt: new Date().toISOString(),
      recipients: [
        { memberName: 'lead', physicalMessageId: 'lead-copy', status: 'accepted' },
        { memberName: 'alice', physicalMessageId: 'alice-copy', status: 'queued' },
      ],
    },
  };
  readStatus.mockResolvedValueOnce({ responsePending: true }).mockResolvedValueOnce({
    ledgerStatus: 'failed_terminal',
    reason: 'group_delivery_unconfirmed',
    responsePending: false,
  });
  try {
    await act(async () =>
      root.render(<GroupDeliveryNotice teamName="test-team" message={message} />)
    );
    expect(container.querySelector('[role=status]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(container.querySelector('[role=status]')?.textContent).toBe('alice');
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(readStatus.mock.calls).toEqual([
      ['test-team', 'alice-copy'],
      ['test-team', 'alice-copy'],
    ]);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it.each(['confirmed', 'unconfirmed', 'pending', 'unavailable'] as const)(
  'uses the original Host observation for %s group delivery without the legacy ledger',
  async (outcome) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    readStatus.mockReset();
    readHostStatus.mockReset();
    const container = document.createElement('div');
    const root = createRoot(container);
    const teamName = hostTeamSelectionKey('original-owner');
    const message: InboxMessage = {
      from: 'user',
      to: 'user',
      text: 'TEST',
      read: true,
      timestamp: new Date().toISOString(),
      groupChatId: 'test-group',
      groupDeliverySummary: {
        recordedAt: new Date().toISOString(),
        recipients: [{ memberName: 'alice', physicalMessageId: 'original-copy', status: 'queued' }],
      },
    };
    if (outcome === 'unavailable')
      readHostStatus.mockRejectedValue(new Error('Original owner unavailable'));
    else
      readHostStatus.mockResolvedValue({
        source: 'captured-host',
        messageId: 'original-copy',
        confirmation: outcome,
        responsePending: outcome === 'pending',
        phase: outcome,
      });
    try {
      await act(async () =>
        root.render(<GroupDeliveryNotice teamName={teamName} message={message} />)
      );
      expect(container.querySelector('[role=status]')?.textContent ?? null).toBe(
        outcome === 'unconfirmed' ? 'alice' : null
      );
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(container.querySelector('[role=status]')?.textContent ?? null).toBe(
        outcome === 'confirmed' ? null : 'alice'
      );
      const count = readHostStatus.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(readHostStatus).toHaveBeenCalledTimes(count);
      expect(
        readHostStatus.mock.calls.every(([team, id]) => team === teamName && id === 'original-copy')
      ).toBe(true);
      expect(readStatus).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }
);
