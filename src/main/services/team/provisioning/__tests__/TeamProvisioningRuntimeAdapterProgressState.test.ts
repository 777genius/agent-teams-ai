import { describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_ADAPTER_PROVISIONING_TRACE_STORAGE_LIMIT,
  type TeamProvisioningRuntimeAdapterProgressMaps,
  TeamProvisioningRuntimeAdapterProgressState,
  type TeamProvisioningRuntimeAdapterProgressStateOptions,
} from '../TeamProvisioningRuntimeAdapterProgressState';

import type { TeamProvisioningProgress } from '@shared/types';

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team',
    state: 'spawning',
    message: 'Launching runtime',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function harness(overrides: Partial<TeamProvisioningRuntimeAdapterProgressStateOptions> = {}) {
  const state: TeamProvisioningRuntimeAdapterProgressMaps = {
    runtimeAdapterProgressByRunId: new Map<string, TeamProvisioningProgress>(),
    runtimeAdapterTraceLinesByRunId: new Map<string, string[]>(),
    runtimeAdapterTraceKeyByRunId: new Map<string, string>(),
  };
  const retainProvisioningProgress = vi.fn();
  const helper = new TeamProvisioningRuntimeAdapterProgressState({
    state,
    retainProvisioningProgress,
    ...overrides,
  });
  return { helper, retainProvisioningProgress, state };
}

describe('TeamProvisioningRuntimeAdapterProgressState', () => {
  it('appends trace lines, dedupes consecutive entries, and keeps NUL-separated keys', () => {
    const { helper, state } = harness();

    helper.setRuntimeAdapterProgress(progress({ pid: 123 }));
    helper.setRuntimeAdapterProgress(progress({ pid: 123 }));
    helper.setRuntimeAdapterProgress(
      progress({
        pid: 123,
        warnings: ['runtime evidence pending'],
        updatedAt: '2026-01-01T00:00:02.000Z',
      })
    );

    expect(state.runtimeAdapterTraceLinesByRunId.get('run-1')).toEqual([
      '2026-01-01T00:00:01.000Z [spawning] Launching runtime - pid=123',
      '2026-01-01T00:00:02.000Z [spawning] Launching runtime - pid=123 | warnings=runtime evidence pending',
    ]);
    expect(state.runtimeAdapterTraceKeyByRunId.get('run-1')).toBe(
      'spawning\u0000Launching runtime\u0000pid=123 | warnings=runtime evidence pending'
    );
  });

  it('truncates stored trace lines to the runtime adapter trace storage limit', () => {
    const { helper, state } = harness();

    for (let index = 0; index < RUNTIME_ADAPTER_PROVISIONING_TRACE_STORAGE_LIMIT + 5; index += 1) {
      helper.setRuntimeAdapterProgress(
        progress({
          message: `message-${index}`,
          updatedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        })
      );
    }

    const lines = state.runtimeAdapterTraceLinesByRunId.get('run-1');
    expect(lines).toHaveLength(RUNTIME_ADAPTER_PROVISIONING_TRACE_STORAGE_LIMIT);
    expect(lines?.[0]).toContain('[spawning] message-5');
    expect(lines?.at(-1)).toContain('[spawning] message-504');
  });

  it('preserves incoming assistantOutput when duplicate trace state leaves no live output', () => {
    const { helper, state } = harness();
    state.runtimeAdapterTraceLinesByRunId.set('run-1', []);
    state.runtimeAdapterTraceKeyByRunId.set('run-1', 'spawning\u0000Launching runtime\u0000');

    const next = helper.setRuntimeAdapterProgress(
      progress({ assistantOutput: 'existing assistant output' })
    );

    expect(next.assistantOutput).toBe('existing assistant output');
    expect(state.runtimeAdapterProgressByRunId.get('run-1')?.assistantOutput).toBe(
      'existing assistant output'
    );
  });

  it.each(['disconnected', 'failed', 'cancelled'] as const)(
    'retains terminal %s progress and invokes the progress callback',
    (stateName) => {
      const { helper, retainProvisioningProgress, state } = harness();
      const onProgress = vi.fn();

      const next = helper.setRuntimeAdapterProgress(
        progress({
          state: stateName,
          message: `Runtime ${stateName}`,
          updatedAt: '2026-01-01T00:00:03.000Z',
        }),
        onProgress
      );

      expect(state.runtimeAdapterProgressByRunId.get('run-1')).toBe(next);
      expect(retainProvisioningProgress).toHaveBeenCalledWith('run-1', next);
      expect(onProgress).toHaveBeenCalledWith(next);
    }
  );

  it('does not retain non-terminal progress', () => {
    const { helper, retainProvisioningProgress } = harness();

    helper.setRuntimeAdapterProgress(progress({ state: 'verifying' }));

    expect(retainProvisioningProgress).not.toHaveBeenCalled();
  });

  it('sweeps stale unreferenced runtime adapter progress and orphan trace state', () => {
    const { helper, retainProvisioningProgress, state } = harness({
      isRuntimeAdapterRunStateReferenced: (runId) => runId === 'live-run',
      runStateTtlMs: 1_000,
      runStateSweepIntervalMs: 0,
    });
    const staleProgress = progress({
      runId: 'stale-run',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const liveProgress = progress({
      runId: 'live-run',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    state.runtimeAdapterProgressByRunId.set('stale-run', staleProgress);
    state.runtimeAdapterProgressByRunId.set('live-run', liveProgress);
    state.runtimeAdapterTraceLinesByRunId.set('stale-run', ['stale trace']);
    state.runtimeAdapterTraceKeyByRunId.set('stale-run', 'stale-key');
    state.runtimeAdapterTraceLinesByRunId.set('orphan-run', ['orphan trace']);
    state.runtimeAdapterTraceKeyByRunId.set('orphan-run', 'orphan-key');

    helper.sweepRuntimeAdapterRunState(Date.parse('2026-01-01T00:00:02.000Z'));

    expect(retainProvisioningProgress).toHaveBeenCalledWith('stale-run', staleProgress);
    expect(state.runtimeAdapterProgressByRunId.has('stale-run')).toBe(false);
    expect(state.runtimeAdapterTraceLinesByRunId.has('stale-run')).toBe(false);
    expect(state.runtimeAdapterTraceKeyByRunId.has('stale-run')).toBe(false);
    expect(state.runtimeAdapterProgressByRunId.get('live-run')).toBe(liveProgress);
    expect(state.runtimeAdapterTraceLinesByRunId.has('orphan-run')).toBe(false);
    expect(state.runtimeAdapterTraceKeyByRunId.has('orphan-run')).toBe(false);
  });

  it('keeps recent unreferenced runtime adapter progress during sweep', () => {
    const { helper, retainProvisioningProgress, state } = harness({
      isRuntimeAdapterRunStateReferenced: () => false,
      runStateTtlMs: 1_000,
      runStateSweepIntervalMs: 0,
    });
    const recentProgress = progress({
      runId: 'recent-run',
      updatedAt: '2026-01-01T00:00:01.500Z',
    });
    state.runtimeAdapterProgressByRunId.set('recent-run', recentProgress);

    helper.sweepRuntimeAdapterRunState(Date.parse('2026-01-01T00:00:02.000Z'));

    expect(retainProvisioningProgress).not.toHaveBeenCalled();
    expect(state.runtimeAdapterProgressByRunId.get('recent-run')).toBe(recentProgress);
  });
});
