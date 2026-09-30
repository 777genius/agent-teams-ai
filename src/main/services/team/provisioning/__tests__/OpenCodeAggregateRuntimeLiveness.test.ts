import { describe, expect, it } from 'vitest';

import { OpenCodeAggregateRuntimeLiveness } from '../OpenCodeAggregateRuntimeLiveness';

function createLiveness(input: {
  progress?: string;
  primary?: boolean;
  secondary?: boolean;
  run?: { child: object | null; processKilled: boolean; cancelRequested: boolean };
}): OpenCodeAggregateRuntimeLiveness {
  return new OpenCodeAggregateRuntimeLiveness({
    getAliveRunId: () => 'run-a',
    hasPrimaryRuntime: () => input.primary ?? false,
    hasSecondaryRuntime: () => input.secondary ?? false,
    getRuntimeProgressState: () => input.progress,
    getRun: () => input.run as never,
  });
}

describe('OpenCodeAggregateRuntimeLiveness', () => {
  it('keeps a healthy tracked primary runtime alive', () => {
    expect(createLiveness({ primary: true }).isTeamAlive('team-a')).toBe(true);
  });

  it('treats terminal aggregate progress without a secondary runtime as stopped', () => {
    expect(
      createLiveness({ primary: true, progress: 'disconnected' }).isTeamAlive('team-a')
    ).toBe(false);
  });

  it('retains an active secondary runtime despite stale aggregate progress', () => {
    expect(
      createLiveness({ secondary: true, progress: 'failed' }).isTeamAlive('team-a')
    ).toBe(true);
  });

  it('falls back to a live child when runtime ownership has not been projected yet', () => {
    expect(
      createLiveness({
        run: { child: {}, processKilled: false, cancelRequested: false },
      }).isTeamAlive('team-a')
    ).toBe(true);
  });
});
