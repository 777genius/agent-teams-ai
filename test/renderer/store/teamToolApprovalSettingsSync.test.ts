import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolApprovalSettingsSynchronizer } from '../../../src/renderer/store/team/teamToolApprovalSettingsSync';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '../../../src/shared/types/team';

describe('ToolApprovalSettingsSynchronizer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries transient failures until main acknowledges the policy', async () => {
    vi.useFakeTimers();
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('main unavailable'))
      .mockRejectedValueOnce(new Error('main still unavailable'))
      .mockResolvedValueOnce(undefined);
    const synchronizer = new ToolApprovalSettingsSynchronizer({
      retryDelaysMs: [10, 20],
      update,
    });

    const revision = synchronizer.schedule('retry-team', DEFAULT_TOOL_APPROVAL_SETTINGS);
    const acknowledged = synchronizer.waitForAcknowledgement('retry-team', revision);
    await vi.runAllTimersAsync();

    await expect(acknowledged).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(3);
    synchronizer.dispose();
  });

  it('serializes in-flight updates and applies the latest revision last', async () => {
    let rejectFirstAttempt: (error: Error) => void = () => undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    const applied: boolean[] = [];
    const update = vi
      .fn()
      .mockReturnValueOnce(firstAttempt)
      .mockImplementationOnce(async (_teamName, settings) => {
        applied.push(settings.autoAllowAll);
      });
    const synchronizer = new ToolApprovalSettingsSynchronizer({
      retryDelaysMs: [0],
      update,
    });
    const oldSettings = DEFAULT_TOOL_APPROVAL_SETTINGS;
    const newSettings = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true };

    synchronizer.schedule('latest-team', oldSettings);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const latestRevision = synchronizer.schedule('latest-team', newSettings);
    rejectFirstAttempt(new Error('stale failure'));

    await synchronizer.waitForAcknowledgement('latest-team', latestRevision);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, 'latest-team', oldSettings);
    expect(update).toHaveBeenNthCalledWith(2, 'latest-team', newSettings);
    expect(applied).toEqual([true]);
    synchronizer.dispose();
  });

  it('never rolls back to an unacknowledged intermediate revision', async () => {
    vi.useFakeTimers();
    let rejectFirstAttempt: (error: Error) => void = () => undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    let mainSettings = DEFAULT_TOOL_APPROVAL_SETTINGS;
    const update = vi
      .fn()
      .mockReturnValueOnce(firstAttempt)
      .mockRejectedValueOnce(new Error('latest revision also failed once'))
      .mockImplementationOnce(async (_teamName, settings) => {
        mainSettings = settings;
      });
    const synchronizer = new ToolApprovalSettingsSynchronizer({
      retryDelaysMs: [10],
      update,
    });
    const intermediate = { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowSafeBash: true };
    const latest = { ...intermediate, autoAllowAll: true };

    synchronizer.schedule('double-failure-team', intermediate);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const latestRevision = synchronizer.schedule('double-failure-team', latest);
    rejectFirstAttempt(new Error('intermediate revision failed'));
    await vi.advanceTimersByTimeAsync(10);

    await synchronizer.waitForAcknowledgement('double-failure-team', latestRevision);
    expect(update).toHaveBeenCalledTimes(3);
    expect(mainSettings).toEqual(latest);
    expect(mainSettings).not.toEqual(intermediate);
    synchronizer.dispose();
  });

  it('continues beyond the initial backoff window instead of giving up', async () => {
    vi.useFakeTimers();
    const retryEvents: number[] = [];
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('failure 1'))
      .mockRejectedValueOnce(new Error('failure 2'))
      .mockRejectedValueOnce(new Error('failure 3'))
      .mockRejectedValueOnce(new Error('failure 4'))
      .mockRejectedValueOnce(new Error('failure 5'))
      .mockResolvedValueOnce(undefined);
    const synchronizer = new ToolApprovalSettingsSynchronizer({
      retryDelaysMs: [1, 2],
      update,
      onRetry: ({ delayMs }) => retryEvents.push(delayMs),
    });

    const revision = synchronizer.schedule('long-outage-team', DEFAULT_TOOL_APPROVAL_SETTINGS);
    const acknowledged = synchronizer.waitForAcknowledgement('long-outage-team', revision);
    await vi.runAllTimersAsync();

    await expect(acknowledged).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(6);
    expect(retryEvents).toEqual([1, 2, 2, 2, 2]);
    synchronizer.dispose();
  });
});
