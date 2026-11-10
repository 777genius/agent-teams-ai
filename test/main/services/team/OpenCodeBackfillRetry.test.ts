import { OpenCodeBackfillRetry } from '@main/services/team/opencode/OpenCodeBackfillRetry';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

it('bounds concurrent failures with capped backoff and resets after success', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const retry = new OpenCodeBackfillRetry();
  const attempt = vi.fn(async () => ({ attempted: true, backfilled: false }));
  const refresh = () => retry.run('task', 'evidence-runtime', attempt);
  let count = 0;
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    await Promise.all(Array.from({ length: 25 }, refresh));
    expect(attempt).toHaveBeenCalledTimes(++count);
    vi.setSystemTime(Date.now() + delay - 1);
    expect(await refresh()).toEqual({ attempted: false, backfilled: false });
    expect(attempt).toHaveBeenCalledTimes(count);
    vi.setSystemTime(Date.now() + 1);
  }
  attempt.mockResolvedValueOnce({ attempted: true, backfilled: true });
  await refresh();
  await refresh();
  expect(attempt).toHaveBeenCalledTimes(count + 2);
  vi.setSystemTime(Date.now() + 5_000);
  await refresh();
  expect(attempt).toHaveBeenCalledTimes(count + 3);
});

it('deduplicates exceptions and preserves evidence/runtime recovery and explicit reset', async () => {
  vi.useFakeTimers();
  const retry = new OpenCodeBackfillRetry();
  const attempt = vi.fn(async () => {
    throw new Error('transport');
  });
  await expect(retry.run('task', 'old', attempt)).rejects.toThrow('transport');
  expect(await retry.run('task', 'old', attempt)).toEqual({ attempted: false, backfilled: false });
  await expect(retry.run('task', 'new', attempt)).rejects.toThrow('transport');
  retry.reset('task');
  await expect(retry.run('task', 'old', attempt)).rejects.toThrow('transport');
  expect(attempt).toHaveBeenCalledTimes(3);
});
