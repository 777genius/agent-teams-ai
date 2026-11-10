import { describe, expect, it } from 'vitest';

import { queryWindowsListenerOwner } from '../../scripts/e2e/opencode-native-desktop-host';

describe('Windows listener ownership probe', () => {
  it('retries a transient command failure instead of failing Electron startup', async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Command failed: powershell.exe'), { code: 1 });
      return { stdout: '4242' };
    };
    await expect(queryWindowsListenerOwner(4242, 9222, run)).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it('gives each attempt a cold-runner budget instead of a 5s kill', async () => {
    let timeout = 0;
    await queryWindowsListenerOwner(1, 9222, async (_file, _args, options) => {
      timeout = options.timeout;
      return { stdout: '' };
    });
    expect(timeout).toBeGreaterThanOrEqual(15_000);
  });

  it('still rejects a probe that fails every attempt', async () => {
    let attempts = 0;
    await expect(
      queryWindowsListenerOwner(1, 9222, async () => {
        attempts += 1;
        throw Object.assign(new Error('Command failed: powershell.exe'), { code: 1 });
      })
    ).rejects.toThrow(/listener ownership probe failed/);
    expect(attempts).toBe(3);
  });

  it('keeps foreign listener ownership a hard failure without retry', async () => {
    let calls = 0;
    await expect(
      queryWindowsListenerOwner(1, 9222, async () => {
        calls += 1;
        return { stdout: '9999' };
      })
    ).rejects.toThrow('Foreign inspector listener');
    expect(calls).toBe(1);
  });
});
