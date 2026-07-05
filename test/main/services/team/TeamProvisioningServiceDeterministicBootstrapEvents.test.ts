import { describe, expect, it } from 'vitest';

import { shouldAcceptDeterministicBootstrapEvent } from '@main/services/team/TeamProvisioningService';

describe('TeamProvisioningService deterministic bootstrap event ordering', () => {
  it('accepts newer in-order bootstrap events', () => {
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        runId: 'run-1',
        teamName: 'atlas-hq',
        lastSeq: 2,
        msg: {
          run_id: 'run-1',
          team_name: 'atlas-hq',
          seq: 3,
        },
      })
    ).toEqual({ accept: true, nextSeq: 3 });
  });

  it('rejects replayed or out-of-order bootstrap events', () => {
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        runId: 'run-1',
        teamName: 'atlas-hq',
        lastSeq: 3,
        msg: {
          run_id: 'run-1',
          team_name: 'atlas-hq',
          seq: 2,
        },
      })
    ).toEqual({ accept: false, nextSeq: 3 });
  });

  it('rejects bootstrap events for another run or team', () => {
    expect(
      shouldAcceptDeterministicBootstrapEvent({
        runId: 'run-1',
        teamName: 'atlas-hq',
        lastSeq: 1,
        msg: {
          run_id: 'run-2',
          team_name: 'atlas-hq',
          seq: 2,
        },
      })
    ).toEqual({ accept: false, nextSeq: 1 });

    expect(
      shouldAcceptDeterministicBootstrapEvent({
        runId: 'run-1',
        teamName: 'atlas-hq',
        lastSeq: 1,
        msg: {
          run_id: 'run-1',
          team_name: 'forge-labs',
          seq: 2,
        },
      })
    ).toEqual({ accept: false, nextSeq: 1 });
  });
});
