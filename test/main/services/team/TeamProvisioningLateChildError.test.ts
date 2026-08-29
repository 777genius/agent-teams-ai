import { registerDeterministicLaunchChildHandlers } from '@main/services/team/provisioning/TeamProvisioningLaunchDeterministicSpawnFlow';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

describe('deterministic launch late child errors', () => {
  it('reconciles a post-spawn child error through the durable process-exit path', async () => {
    const child = new EventEmitter();
    const handleProcessExit = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();
    const updateProgress = vi.fn();
    const run = {
      runId: 'late-error-run',
      teamName: 'late-error-team',
      child,
      processClosed: false,
      processKilled: false,
      provisioningComplete: false,
      cancelRequested: false,
      deterministicBootstrap: true,
      effectiveMembers: [],
      lastDataReceivedAt: 0,
      onProgress: vi.fn(),
      progress: { state: 'spawning' },
      timeoutHandle: null,
    };
    registerDeterministicLaunchChildHandlers(
      { run: run as never, child: child as never },
      {
        setTimeout: vi.fn(() => ({}) as NodeJS.Timeout),
        tryCompleteAfterTimeout: vi.fn(async () => false),
        killTeamProcessAndWait: vi.fn(async () => undefined),
        updateProgress,
        cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => undefined),
        cleanupRun,
        handleProcessExit,
      } as never
    );

    child.emit('error', new Error('late child error'));
    await vi.waitFor(() => expect(handleProcessExit).toHaveBeenCalledWith(run, null));
    expect(updateProgress).not.toHaveBeenCalled();
    expect(cleanupRun).not.toHaveBeenCalled();
  });
});
