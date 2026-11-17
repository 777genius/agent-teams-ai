import { describe, expect, it, vi } from 'vitest';

import { changeTeamProjectContextMode } from '../../../src/features/team-project-context/main/TeamProjectContextModeService';

import type { TeamProjectContextModePorts } from '../../../src/features/team-project-context/main/TeamProjectContextModeService';

function fixture(mode?: 'shared' | 'per_project') {
  const ports: TeamProjectContextModePorts = {
    getMeta: vi.fn(async () => ({
      ...(mode ? { projectContextMode: mode } : {}),
    })),
    metadataFileExists: vi.fn(async () => true),
    updateMode: vi.fn(async () => undefined),
    withLogicalTeamLock: vi.fn(async <T>(_: string, operation: () => Promise<T>) => operation()),
    assertProfileOwnedForModeChange: vi.fn(async () => undefined),
    listContexts: vi.fn(async () => []),
    getRuntimeState: vi.fn(async (name) => ({
      teamName: name, isAlive: false, runId: null, progress: null,
    })),
    hasProvisioningRun: vi.fn(() => false),
    hasActiveSchedules: vi.fn(async () => false),
  };
  return ports;
}

describe('changeTeamProjectContextMode', () => {
  it('preserves legacy shared mode and persists an explicit per-project choice', async () => {
    const f = fixture();
    await changeTeamProjectContextMode('builders', 'per_project', f);
    expect(f.updateMode).toHaveBeenCalledWith('builders', 'per_project');
  });

  it('rejects live or degraded contexts and retains the previous mode', async () => {
    const f = fixture('per_project');
    f.listContexts = vi.fn(async () => [
      { executionTeamName: 'ptc-a', state: 'ready' as const },
    ]);
    f.getRuntimeState = vi.fn(async (name) => ({
      teamName: name,
      isAlive: name === 'ptc-a',
      runId: name === 'ptc-a' ? 'run-a' : null,
      progress: null,
    }));
    await expect(changeTeamProjectContextMode('builders', 'shared', f))
      .rejects.toThrow('running');
    expect(f.updateMode).not.toHaveBeenCalled();
  });

  it('blocks a mode change while schedules can target old contexts', async () => {
    const f = fixture('per_project');
    f.listContexts = vi.fn(async () => [
      { executionTeamName: 'ptc-a', state: 'ready' as const },
    ]);
    f.hasActiveSchedules = vi.fn(async () => true);
    await expect(changeTeamProjectContextMode('builders', 'shared', f))
      .rejects.toThrow('Pause active team schedules');
    expect(f.updateMode).not.toHaveBeenCalled();
  });

  it('never changes mode while another context is only reserved', async () => {
    const f = fixture('per_project');
    f.listContexts = vi.fn(async () => [
      { executionTeamName: 'ptc-a', state: 'reserved' as const },
    ]);
    await expect(changeTeamProjectContextMode('builders', 'shared', f))
      .rejects.toThrow('reconciled');
    expect(f.updateMode).not.toHaveBeenCalled();
  });

  it('does not mutate a deleted team or silently create missing metadata', async () => {
    const f = fixture();
    f.getMeta = vi.fn(async () => ({ deletedAt: '2026-11-17T00:00:00.000Z' }));
    await expect(changeTeamProjectContextMode('builders', 'per_project', f))
      .rejects.toThrow('TEAM_TRASHED');
    expect(f.updateMode).not.toHaveBeenCalled();
    f.getMeta = vi.fn(async () => null);
    await expect(changeTeamProjectContextMode('builders', 'per_project', f))
      .rejects.toThrow('unreadable');
  });
});
