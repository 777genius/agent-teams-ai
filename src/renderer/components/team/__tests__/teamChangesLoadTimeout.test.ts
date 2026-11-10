import { describe, expect, it, vi } from 'vitest';

import { withTeamChangesLoadTimeout } from '../teamChangesLoadTimeout';

describe('withTeamChangesLoadTimeout', () => {
  it('resolves when the request finishes before the timeout', async () => {
    await expect(withTeamChangesLoadTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok');
  });

  it('rejects when the request does not finish before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const request = withTeamChangesLoadTimeout(new Promise(() => undefined), 1000);
      const expectation = expect(request).rejects.toThrow('Team changes request timed out');

      await vi.advanceTimersByTimeAsync(1000);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
