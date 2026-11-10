import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupRunOwnedAnthropicApiKeyHelper,
  createAnthropicApiKeyHelperCleanupRetryOwner,
  createAnthropicApiKeyHelperSetupLease,
} from '../TeamProvisioningAnthropicApiKeyHelperLease';

import type { AnthropicTeamApiKeyHelperMaterial } from '../../../runtime/anthropicTeamApiKeyHelper';

function createHelper(directory = '/fixtures/auth/run-1'): AnthropicTeamApiKeyHelperMaterial {
  return {
    teamName: 'fixture-team',
    directory,
    helperPath: `${directory}/helper.sh`,
    keyPath: `${directory}/key`,
    settingsPath: `${directory}/settings.json`,
    settingsObject: { apiKeyHelper: `${directory}/helper.sh` },
    settingsArgs: ['--settings', `${directory}/settings.json`],
    envPatch: { CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH: `${directory}/settings.json` },
  };
}

describe('Anthropic API-key helper provisioning lease', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces primary and cross-provider ownership before transferring the exact material', async () => {
    const cleanupMaterial = vi.fn(async () => undefined);
    const lease = createAnthropicApiKeyHelperSetupLease(cleanupMaterial);
    const primaryMaterial = createHelper();
    const crossProviderMaterial = { ...primaryMaterial };
    const run = {
      anthropicApiKeyHelper: null,
      anthropicApiKeyHelperCleanupPromise: null,
    };

    lease.coalesce(primaryMaterial);
    lease.coalesce(crossProviderMaterial);
    expect(lease.getOwnedMaterial()).toBe(crossProviderMaterial);

    expect(lease.transferTo(run)).toBe(crossProviderMaterial);
    expect(run.anthropicApiKeyHelper).toBe(crossProviderMaterial);
    await lease.cleanup();
    expect(cleanupMaterial).not.toHaveBeenCalled();

    await Promise.all([
      cleanupRunOwnedAnthropicApiKeyHelper(run, cleanupMaterial),
      cleanupRunOwnedAnthropicApiKeyHelper(run, cleanupMaterial),
    ]);
    expect(cleanupMaterial).toHaveBeenCalledOnce();
    expect(cleanupMaterial).toHaveBeenCalledWith({ directory: primaryMaterial.directory });
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('retains exact ownership when cleanup fails so a later cleanup can retry', async () => {
    const material = createHelper();
    const run = {
      anthropicApiKeyHelper: material,
      anthropicApiKeyHelperCleanupPromise: null,
    };
    const cleanupMaterial = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);

    await expect(cleanupRunOwnedAnthropicApiKeyHelper(run, cleanupMaterial)).rejects.toThrow(
      'busy'
    );
    expect(run.anthropicApiKeyHelper).toBe(material);

    await cleanupRunOwnedAnthropicApiKeyHelper(run, cleanupMaterial);
    expect(cleanupMaterial).toHaveBeenCalledTimes(2);
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('retains every conflicting setup material for failure cleanup', async () => {
    const cleanupMaterial = vi.fn(async () => undefined);
    const lease = createAnthropicApiKeyHelperSetupLease(cleanupMaterial);
    const first = createHelper('/fixtures/auth/run-1');
    const second = createHelper('/fixtures/auth/run-2');

    lease.coalesce(first);
    expect(() => lease.coalesce(second)).toThrow(
      'Deterministic setup produced conflicting Anthropic API-key helpers'
    );
    await lease.cleanup();

    expect(cleanupMaterial).toHaveBeenCalledTimes(2);
    expect(cleanupMaterial).toHaveBeenCalledWith({ directory: first.directory });
    expect(cleanupMaterial).toHaveBeenCalledWith({ directory: second.directory });
  });

  it('keeps a failed setup lease reachable and retries it for the owning team', async () => {
    const cleanupMaterial = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);
    const lease = createAnthropicApiKeyHelperSetupLease(cleanupMaterial);
    const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner();
    lease.coalesce(createHelper());

    await expect(lease.cleanup()).rejects.toThrow('busy');
    await retryOwner.retainSetupLease(lease);
    expect(retryOwner.getPendingOwnerCount()).toBe(1);

    await retryOwner.retryPendingForTeam('fixture-team');

    expect(cleanupMaterial).toHaveBeenCalledTimes(2);
    expect(retryOwner.getPendingOwnerCount()).toBe(0);
  });

  it('keeps automatic cleanup retries and retained ownership explicitly bounded', async () => {
    vi.useFakeTimers();
    const cleanupMaterial = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValue(new Error('still busy'));
    const lease = createAnthropicApiKeyHelperSetupLease(cleanupMaterial);
    const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner({
      maxPendingOwners: 1,
      retryDelaysMs: [10, 20],
    });
    lease.coalesce(createHelper());
    await expect(lease.cleanup()).rejects.toThrow('still busy');

    await retryOwner.retainSetupLease(lease);
    expect(retryOwner.getPendingOwnerCount()).toBe(1);
    expect(retryOwner.hasPendingForTeam('fixture-team')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    expect(cleanupMaterial).toHaveBeenCalledTimes(3);
    expect(retryOwner.getPendingOwnerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    cleanupMaterial.mockResolvedValue(undefined);
    await retryOwner.retryPendingForTeam('fixture-team');
    expect(retryOwner.getPendingOwnerCount()).toBe(0);
  });

  it('returns the exact overflow owner after a bounded global drain cannot free capacity', async () => {
    vi.useFakeTimers();
    const firstCleanup = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValue(new Error('first cleanup remains busy'));
    const secondCleanup = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('second cleanup initially busy'))
      .mockResolvedValueOnce(undefined);
    const firstLease = createAnthropicApiKeyHelperSetupLease(firstCleanup);
    const secondLease = createAnthropicApiKeyHelperSetupLease(secondCleanup);
    firstLease.coalesce({ ...createHelper('/fixtures/auth/first'), teamName: 'first-team' });
    secondLease.coalesce({ ...createHelper('/fixtures/auth/second'), teamName: 'second-team' });
    const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner({
      maxPendingOwners: 1,
      retryDelaysMs: [10],
    });

    await expect(firstLease.cleanup()).rejects.toThrow('first cleanup remains busy');
    await retryOwner.retainSetupLease(firstLease);
    await vi.advanceTimersByTimeAsync(10);
    expect(firstCleanup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await expect(secondLease.cleanup()).rejects.toThrow('second cleanup initially busy');
    const overflowRetention = await retryOwner.retainSetupLease(secondLease);

    expect(retryOwner.getPendingOwnerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(firstCleanup).toHaveBeenCalledTimes(3);
    expect(overflowRetention.kind).toBe('source-owned');
    if (overflowRetention.kind !== 'source-owned') {
      throw new Error('Expected bounded cleanup ownership handoff');
    }
    expect(overflowRetention.owner.kind).toBe('setup');
    expect(overflowRetention.owner.teamName).toBe('second-team');
    expect(overflowRetention.owner.directory).toBe('/fixtures/auth/second');
    if (overflowRetention.owner.kind !== 'setup') {
      throw new Error('Expected setup cleanup owner');
    }
    expect(overflowRetention.owner.lease).toBe(secondLease);
    expect(secondLease.getOwnedMaterial()?.directory).toBe('/fixtures/auth/second');

    await overflowRetention.owner.retryCleanup();
    expect(secondCleanup).toHaveBeenCalledTimes(2);
    expect(secondLease.getOwnedMaterial()).toBeNull();
    expect(retryOwner.getPendingOwnerCount()).toBe(1);
    expect(retryOwner.hasPendingForTeam('first-team')).toBe(true);
    expect(retryOwner.hasPendingForTeam('second-team')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let one never-settling cleanup block another team retain decision', async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => undefined);
    const firstCleanup = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first cleanup initially busy'))
      .mockReturnValue(neverSettles);
    const secondCleanup = vi
      .fn<(input: { directory: string }) => Promise<void>>()
      .mockRejectedValue(new Error('second cleanup remains busy'));
    const firstLease = createAnthropicApiKeyHelperSetupLease(firstCleanup);
    const secondLease = createAnthropicApiKeyHelperSetupLease(secondCleanup);
    firstLease.coalesce({ ...createHelper('/fixtures/auth/stalled'), teamName: 'stalled-team' });
    secondLease.coalesce({
      ...createHelper('/fixtures/auth/unrelated'),
      teamName: 'unrelated-team',
    });
    const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner({
      maxPendingOwners: 1,
      retryDelaysMs: [10],
    });

    await expect(firstLease.cleanup()).rejects.toThrow('first cleanup initially busy');
    await retryOwner.retainSetupLease(firstLease);
    await expect(secondLease.cleanup()).rejects.toThrow('second cleanup remains busy');

    let decided = false;
    const retentionPromise = retryOwner.retainSetupLease(secondLease).then((retention) => {
      decided = true;
      return retention;
    });
    await Promise.resolve();

    expect(firstCleanup).toHaveBeenCalledTimes(2);
    expect(decided).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    const retention = await retentionPromise;

    expect(retention.kind).toBe('source-owned');
    expect(decided).toBe(true);
    expect(retryOwner.getPendingOwnerCount()).toBe(1);
    expect(retryOwner.hasPendingForTeam('stalled-team')).toBe(true);
    expect(retryOwner.hasPendingForTeam('unrelated-team')).toBe(false);
    expect(secondLease.getOwnedMaterial()?.directory).toBe('/fixtures/auth/unrelated');
  });
});
