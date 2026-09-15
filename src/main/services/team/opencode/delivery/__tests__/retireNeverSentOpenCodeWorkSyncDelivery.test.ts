import { describe, expect, it, vi } from 'vitest';

import { retireNeverSentOpenCodeWorkSyncDelivery } from '../retireNeverSentOpenCodeWorkSyncDelivery';

describe('retireNeverSentOpenCodeWorkSyncDelivery', () => {
  it('terminals a pending never-sent record blocked by Stop', async () => {
    const markFailedTerminal = vi.fn(async (input: { id: string }) => input);
    await retireNeverSentOpenCodeWorkSyncDelivery({
      ledger: { markFailedTerminal } as never,
      record: {
        id: 'ledger-c1',
        status: 'pending',
        acceptedAt: null,
        attempts: 0,
      } as never,
      reason: 'work_sync_admission_stopped',
      nowIso: '2026-05-09T12:00:00.000Z',
    });
    expect(markFailedTerminal).toHaveBeenCalledWith({
      id: 'ledger-c1',
      reason: 'work_sync_admission_stopped',
      failedAt: '2026-05-09T12:00:00.000Z',
    });
  });

  it('leaves observe of an accepted prompt and lane-reserved waits alone', async () => {
    const markFailedTerminal = vi.fn(async (input: { id: string }) => input);
    await retireNeverSentOpenCodeWorkSyncDelivery({
      ledger: { markFailedTerminal } as never,
      record: {
        id: 'ledger-accepted',
        status: 'accepted',
        acceptedAt: '2026-05-09T11:00:00.000Z',
        attempts: 1,
      } as never,
      reason: 'work_sync_ticket_consumed',
      nowIso: '2026-05-09T12:00:00.000Z',
    });
    await retireNeverSentOpenCodeWorkSyncDelivery({
      ledger: { markFailedTerminal } as never,
      record: {
        id: 'ledger-wait',
        status: 'pending',
        acceptedAt: null,
        attempts: 0,
      } as never,
      reason: 'work_sync_lane_reserved',
      nowIso: '2026-05-09T12:00:00.000Z',
    });
    expect(markFailedTerminal).not.toHaveBeenCalled();
  });
});
