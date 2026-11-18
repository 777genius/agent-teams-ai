import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  rememberProjectRunIdentity,
  resolveProjectRunDiagnosticsTeam,
  projectPublicProvisioningProgress,
} from '../../../src/main/ipc/teams/teamProjectContextProgressIdentity';

describe('project provisioning diagnostics identity', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('resolves the exact physical team for the logical team and run', () => {
    rememberProjectRunIdentity('run-diagnostics-a', 'logical', 'ptc-project-a');
    expect(resolveProjectRunDiagnosticsTeam('logical', 'run-diagnostics-a'))
      .toBe('ptc-project-a');
    const progress = projectPublicProvisioningProgress({
      teamName: 'ptc-project-a',
      runId: 'run-diagnostics-a',
      state: 'failed',
      message: 'failed',
      startedAt: '', updatedAt: '',
    });
    expect(progress.teamName).toBe('logical');
  });

  it('does not expose another logical team diagnostics when the run ID is supplied', () => {
    rememberProjectRunIdentity('run-diagnostics-b', 'first-logical', 'ptc-first');
    expect(resolveProjectRunDiagnosticsTeam('second-logical', 'run-diagnostics-b'))
      .toBe('second-logical');
    expect(resolveProjectRunDiagnosticsTeam('first-logical', 'unrelated'))
      .toBe('first-logical');
    expect(resolveProjectRunDiagnosticsTeam('first-logical', undefined))
      .toBe('first-logical');
  });

  it('does not route expired in-memory provisioning evidence to an alias', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T10:00:00.000Z'));
    rememberProjectRunIdentity('run-diagnostics-expired', 'logical', 'ptc-old');
    vi.setSystemTime(new Date('2026-11-18T15:00:00.000Z'));
    expect(resolveProjectRunDiagnosticsTeam('logical', 'run-diagnostics-expired'))
      .toBe('logical');
  });
});
