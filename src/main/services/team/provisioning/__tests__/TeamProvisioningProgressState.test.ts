import { describe, expect, it, vi } from 'vitest';

import {
  isTerminalFailureProvisioningState,
  looksLikeClaudeStdoutJsonFragment,
  shouldIgnoreProvisioningProgressRegression,
  TeamProvisioningRetainedProgressState,
} from '../TeamProvisioningProgressState';

import type { TeamLaunchDiagnosticItem, TeamProvisioningProgress } from '@shared/types';

type FakeTimer = ReturnType<typeof setTimeout> & {
  fire(): void;
  timeoutMs: number;
  unref: ReturnType<typeof vi.fn>;
};

function fakeTimer(handler: () => void, timeoutMs: number): FakeTimer {
  return {
    fire: handler,
    timeoutMs,
    unref: vi.fn(),
  } as unknown as FakeTimer;
}

function diagnostic(overrides: Partial<TeamLaunchDiagnosticItem> = {}): TeamLaunchDiagnosticItem {
  return {
    id: 'diag-1',
    severity: 'warning',
    code: 'runtime_process_detected',
    label: 'Runtime process detected',
    observedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team',
    state: 'failed',
    message: 'Failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

type RetainedProgressStateOptions = ConstructorParameters<
  typeof TeamProvisioningRetainedProgressState
>[0];

function retainedState(overrides: Partial<RetainedProgressStateOptions> = {}) {
  const runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  const runtimeAdapterTraceLinesByRunId = new Map<string, string[]>();
  const runtimeAdapterTraceKeyByRunId = new Map<string, string>();
  const state = new TeamProvisioningRetainedProgressState({
    runtimeAdapterProgressByRunId,
    runtimeAdapterTraceLinesByRunId,
    runtimeAdapterTraceKeyByRunId,
    ...overrides,
  });
  return {
    runtimeAdapterProgressByRunId,
    runtimeAdapterTraceLinesByRunId,
    runtimeAdapterTraceKeyByRunId,
    state,
  };
}

describe('TeamProvisioningProgressState', () => {
  describe('looksLikeClaudeStdoutJsonFragment', () => {
    it('recognizes stream-json object/array fragments by shape key', () => {
      expect(looksLikeClaudeStdoutJsonFragment('{"type":"assistant"}')).toBe(true);
      expect(looksLikeClaudeStdoutJsonFragment('  {"session_id":"s"} ')).toBe(true);
      expect(looksLikeClaudeStdoutJsonFragment('[{"message":{}}]')).toBe(true);
    });

    it('rejects non-json and json without known shape keys', () => {
      expect(looksLikeClaudeStdoutJsonFragment('hello world')).toBe(false);
      expect(looksLikeClaudeStdoutJsonFragment('{"other":1}')).toBe(false);
      expect(looksLikeClaudeStdoutJsonFragment('type: x')).toBe(false);
    });
  });

  describe('isTerminalFailureProvisioningState', () => {
    it('is true only for failed/cancelled/disconnected', () => {
      expect(isTerminalFailureProvisioningState('failed')).toBe(true);
      expect(isTerminalFailureProvisioningState('cancelled')).toBe(true);
      expect(isTerminalFailureProvisioningState('disconnected')).toBe(true);
      expect(isTerminalFailureProvisioningState('ready')).toBe(false);
      expect(isTerminalFailureProvisioningState('spawning')).toBe(false);
    });
  });

  describe('shouldIgnoreProvisioningProgressRegression', () => {
    it('lets a ready run stay ready or disconnect, but ignores other transitions', () => {
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'ready')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'disconnected')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'spawning')).toBe(true);
      expect(shouldIgnoreProvisioningProgressRegression('ready', 'failed')).toBe(true);
    });

    it('pins a terminal-failure run and ignores flips to a different state', () => {
      expect(shouldIgnoreProvisioningProgressRegression('failed', 'failed')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('failed', 'ready')).toBe(true);
      expect(shouldIgnoreProvisioningProgressRegression('cancelled', 'spawning')).toBe(true);
    });

    it('allows normal forward progress from non-settled states', () => {
      expect(shouldIgnoreProvisioningProgressRegression('spawning', 'configuring')).toBe(false);
      expect(shouldIgnoreProvisioningProgressRegression('verifying', 'ready')).toBe(false);
    });
  });

  describe('TeamProvisioningRetainedProgressState', () => {
    it('clones retained progress arrays and returns undefined for an unknown run', () => {
      const { state } = retainedState();
      const launchDiagnostics = [diagnostic()];
      const warnings = ['first warning'];
      const original = progress({ launchDiagnostics, warnings });

      state.retainProvisioningProgress('run-1', original);
      warnings.push('mutated warning');
      launchDiagnostics.push(diagnostic({ id: 'diag-2' }));

      const retained = state.findProvisioningStatus('run-1', new Map());
      expect(retained).toBeDefined();
      if (!retained) throw new Error('Expected retained progress');
      expect(retained.warnings).toEqual(['first warning']);
      expect(retained.warnings).not.toBe(warnings);
      expect(retained.launchDiagnostics).toEqual([diagnostic()]);
      expect(retained.launchDiagnostics).not.toBe(launchDiagnostics);
      expect(state.findProvisioningStatus('missing-run', new Map())).toBeUndefined();
    });

    it('resolves active, runtime-adapter, and retained progress in that order', () => {
      const harness = retainedState();
      const retained = progress({ message: 'retained' });
      const runtimeAdapter = progress({ message: 'runtime-adapter' });
      const active = progress({ message: 'active' });
      const runs = new Map([['run-1', { progress: active }]]);

      harness.state.retainProvisioningProgress('run-1', retained);
      harness.runtimeAdapterProgressByRunId.set('run-1', runtimeAdapter);

      expect(harness.state.findProvisioningStatus('run-1', runs)).toBe(active);
      runs.delete('run-1');
      expect(harness.state.findProvisioningStatus('run-1', runs)).toBe(runtimeAdapter);
      harness.runtimeAdapterProgressByRunId.delete('run-1');
      expect(harness.state.findProvisioningStatus('run-1', runs)?.message).toBe('retained');
    });

    it('unrefs retention timers and removes terminal runtime adapter traces when fired', () => {
      const scheduled: FakeTimer[] = [];
      const setTimeoutPort = vi.fn((handler: () => void, timeoutMs: number) => {
        const timer = fakeTimer(handler, timeoutMs);
        scheduled.push(timer);
        return timer;
      });
      const harness = retainedState({ setTimeout: setTimeoutPort, ttlMs: 25 });
      harness.runtimeAdapterProgressByRunId.set(
        'terminal-run',
        progress({ runId: 'terminal-run' })
      );
      harness.runtimeAdapterTraceLinesByRunId.set('terminal-run', ['trace']);
      harness.runtimeAdapterTraceKeyByRunId.set('terminal-run', 'trace-key');

      harness.state.retainProvisioningProgress(
        'terminal-run',
        progress({ runId: 'terminal-run', state: 'failed' })
      );

      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.timeoutMs).toBe(25);
      expect(scheduled[0]?.unref).toHaveBeenCalledTimes(1);

      scheduled[0]?.fire();

      expect(harness.runtimeAdapterProgressByRunId.has('terminal-run')).toBe(false);
      expect(harness.runtimeAdapterTraceLinesByRunId.has('terminal-run')).toBe(false);
      expect(harness.runtimeAdapterTraceKeyByRunId.has('terminal-run')).toBe(false);
      expect(harness.state.findProvisioningStatus('terminal-run', new Map())).toBeUndefined();
    });

    it('keeps a reused live runtime adapter run after retained progress expires', () => {
      const scheduled: FakeTimer[] = [];
      const harness = retainedState({
        setTimeout: (handler, timeoutMs) => {
          const timer = fakeTimer(handler, timeoutMs);
          scheduled.push(timer);
          return timer;
        },
      });
      const liveProgress = progress({ runId: 'reused-run', state: 'spawning' });
      harness.runtimeAdapterProgressByRunId.set('reused-run', liveProgress);
      harness.runtimeAdapterTraceLinesByRunId.set('reused-run', ['trace']);
      harness.runtimeAdapterTraceKeyByRunId.set('reused-run', 'trace-key');

      harness.state.retainProvisioningProgress(
        'reused-run',
        progress({ runId: 'reused-run', state: 'cancelled' })
      );
      scheduled[0]?.fire();

      expect(harness.runtimeAdapterProgressByRunId.get('reused-run')).toBe(liveProgress);
      expect(harness.runtimeAdapterTraceLinesByRunId.get('reused-run')).toEqual(['trace']);
      expect(harness.runtimeAdapterTraceKeyByRunId.get('reused-run')).toBe('trace-key');
    });
  });
});
