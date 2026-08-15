import { describe, expect, it, vi } from 'vitest';

import {
  observeHostedApprovalRuntimeFailure,
  observeHostedApprovalRuntimeTeamChange,
} from '../HostedApprovalRuntimeDesktopLifecycle';

import type { HostedApprovalRuntimeTransitionService } from '../HostedApprovalRuntimeTransitionService';

describe('HostedApprovalRuntimeDesktopLifecycle', () => {
  it('returns an awaited process-failure revocation barrier', async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const durableUnlink = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      async beforeFailure(_teamName: string, effect: () => Promise<void>) {
        events.push('unlink:start');
        await durableUnlink;
        events.push('unlink:directory-fsynced');
        await effect();
      },
    } as HostedApprovalRuntimeTransitionService;

    const observed = observeHostedApprovalRuntimeFailure(
      runtime,
      {
        teamName: 'team-a',
        memberName: 'lead',
        runId: 'run-a',
        phase: 'terminal',
        detail: 'process-exit',
        observedAt: new Date(0).toISOString(),
      },
      { error: vi.fn() }
    );
    await Promise.resolve();
    expect(events).toEqual(['unlink:start']);
    release?.();
    await observed;
    expect(events).toEqual(['unlink:start', 'unlink:directory-fsynced']);
  });

  it('fails closed when owner-loss revocation cannot be confirmed', async () => {
    const failure = new Error('hosted-approval-runtime-revocation-unconfirmed');
    const logger = { error: vi.fn() };
    const runtime = {
      beforeOwnerLoss: async () => {
        throw failure;
      },
    } as unknown as HostedApprovalRuntimeTransitionService;

    await expect(
      observeHostedApprovalRuntimeTeamChange(
        runtime,
        { type: 'process', teamName: 'team-a', detail: 'disconnected' },
        logger
      )
    ).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith(
      'Hosted approval runtime owner-loss revocation failed:',
      failure
    );
  });
});
