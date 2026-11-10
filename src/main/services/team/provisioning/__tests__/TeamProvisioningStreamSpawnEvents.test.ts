import { describe, expect, it, vi } from 'vitest';

import {
  captureTeamSpawnEvents,
  type TeamProvisioningStreamSpawnRun,
} from '../TeamProvisioningStreamSpawnEvents';

import type { TeamProvisioningProgress } from '@shared/types';

function createRun(
  overrides: Partial<TeamProvisioningStreamSpawnRun> = {}
): TeamProvisioningStreamSpawnRun {
  const progress = {
    runId: 'run-1',
    teamName: 'alpha',
    state: 'configuring',
    message: 'Configuring',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as TeamProvisioningProgress;
  return {
    teamName: 'alpha',
    provisioningComplete: false,
    progress,
    memberSpawnStatuses: new Map(),
    memberSpawnToolUseIds: new Map(),
    onProgress: vi.fn(),
    ...overrides,
  };
}

function createPorts() {
  return {
    logger: {
      warn: vi.fn(),
    },
    setMemberSpawnStatus: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    updateProgress: vi.fn(
      (run: TeamProvisioningStreamSpawnRun, state: 'assembling', message: string) => ({
        ...run.progress,
        state,
        message,
      })
    ),
  };
}

describe('stream spawn event helpers', () => {
  it('marks same-team Agent tool calls as spawning and advances progress', () => {
    const run = createRun();
    const ports = createPorts();

    captureTeamSpawnEvents(
      run,
      [
        {
          type: 'tool_use',
          name: 'Agent',
          id: 'tool-1',
          input: { team_name: 'alpha', name: 'dev' },
        },
      ],
      ports
    );

    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(run, 'dev', 'spawning');
    expect(run.memberSpawnToolUseIds.get('tool-1')).toBe('dev');
    expect(ports.updateProgress).toHaveBeenCalledWith(run, 'assembling', 'Spawning member dev...');
    expect(run.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'assembling', message: 'Spawning member dev...' })
    );
  });

  it('warns and records an error when Agent is missing team_name', () => {
    const run = createRun();
    const ports = createPorts();

    captureTeamSpawnEvents(
      run,
      [{ type: 'tool_use', name: 'Agent', input: { name: 'dev' } }],
      ports
    );

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[captureTeamSpawnEvents] Agent call for "dev" is missing team_name - teammate will be an ephemeral subagent, not a persistent member of "alpha"'
    );
    expect(ports.setMemberSpawnStatus).toHaveBeenCalledWith(
      run,
      'dev',
      'error',
      'Agent spawn for "dev" is missing team_name - spawned as ephemeral subagent instead of persistent teammate'
    );
  });

  it('warns when Agent has team_name but no member name', () => {
    const run = createRun();
    const ports = createPorts();

    captureTeamSpawnEvents(
      run,
      [{ type: 'tool_use', name: 'Agent', input: { team_name: 'alpha' } }],
      ports
    );

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[captureTeamSpawnEvents] Agent call for team "alpha" is missing name - runtime will spawn an ephemeral subagent instead of a persistent teammate'
    );
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });

  it('ignores other-team Agent calls', () => {
    const run = createRun();
    const ports = createPorts();

    captureTeamSpawnEvents(
      run,
      [{ type: 'tool_use', name: 'Agent', input: { team_name: 'beta', name: 'dev' } }],
      ports
    );

    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
    expect(run.onProgress).not.toHaveBeenCalled();
  });

  it('blocks duplicate respawn signals when the member is already online', () => {
    const run = createRun({
      memberSpawnStatuses: new Map([['dev', { runtimeAlive: true }]]),
    });
    const ports = createPorts();

    captureTeamSpawnEvents(
      run,
      [{ type: 'tool_use', name: 'Agent', input: { team_name: 'alpha', name: 'dev' } }],
      ports
    );

    expect(ports.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      run,
      'dev',
      'respawn blocked as duplicate - teammate already online'
    );
    expect(ports.setMemberSpawnStatus).not.toHaveBeenCalled();
  });
});
