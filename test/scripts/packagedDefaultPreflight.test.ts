import { describe, expect, it } from 'vitest';

import {
  nativeDiagnosticProgress,
  type PreflightEvent,
} from '../../scripts/e2e/anthropic-compatible-status/packaged-default-preflight';

const start = (): PreflightEvent => ({
  at: '2026-10-20T00:00:00Z',
  event: 'provider_one_shot_diagnostic_start',
});
const complete = (ok = true): PreflightEvent => ({
  at: '2026-10-20T00:00:01Z',
  event: 'provider_one_shot_diagnostic_complete',
  ok,
});

describe('packaged native diagnostic evidence', () => {
  it('drains an existing successful pair without claiming a new revalidation', () => {
    const events = [start(), complete()];
    expect(nativeDiagnosticProgress(events, events.length, 'quiet-drain').ready).toBe(true);
    expect(nativeDiagnosticProgress(events, events.length, 'fresh-diagnostic').ready).toBe(false);
  });

  it('requires an initial diagnostic even for a quiet drain', () => {
    expect(nativeDiagnosticProgress([], 0, 'quiet-drain').ready).toBe(false);
  });

  it('does not accept an earlier invocation completing after the action as a new pair', () => {
    expect(nativeDiagnosticProgress([start(), complete()], 1, 'fresh-diagnostic').ready).toBe(
      false
    );
  });

  it('does not accept unrelated new events as a fresh native diagnostic', () => {
    const events = [start(), complete(), { at: '', event: 'provider_status_complete' }];
    expect(nativeDiagnosticProgress(events, 2, 'fresh-diagnostic').ready).toBe(false);
  });

  it('waits for the action-triggered invocation to complete', () => {
    expect(
      nativeDiagnosticProgress([start(), complete(), start()], 2, 'fresh-diagnostic').ready
    ).toBe(false);
  });

  it('accepts a completed successful pair that started after the action baseline', () => {
    const progress = nativeDiagnosticProgress(
      [start(), complete(), start(), complete()],
      2,
      'fresh-diagnostic'
    );
    expect(progress.ready).toBe(true);
    expect(progress.freshStartCount).toBe(1);
    expect(progress.freshCompleteCount).toBe(1);
  });

  it.each(['quiet-drain', 'fresh-diagnostic'] as const)(
    'never hides an earlier failed diagnostic during %s',
    (requirement) => {
      const progress = nativeDiagnosticProgress(
        [start(), complete(false), start(), complete()],
        2,
        requirement
      );
      expect(progress.allSucceeded).toBe(false);
      expect(progress.ready).toBe(false);
    }
  );

  it('rejects a failed action-triggered completion', () => {
    const progress = nativeDiagnosticProgress(
      [start(), complete(), start(), complete(false)],
      2,
      'fresh-diagnostic'
    );
    expect(progress.allSucceeded).toBe(false);
    expect(progress.ready).toBe(false);
  });
});
