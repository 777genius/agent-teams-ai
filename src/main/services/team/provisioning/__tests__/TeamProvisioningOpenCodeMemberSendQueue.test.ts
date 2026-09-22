import { describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';

import type { OpenCodeTeamRuntimeMessageResult } from '../../runtime/OpenCodeTeamRuntimeAdapter';

interface OpenCodeMemberSendQueuePort {
  sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    memberName: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function result(memberName: string): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName,
    diagnostics: [],
  };
}

describe('TeamProvisioningService OpenCode member send queue', () => {
  it('keeps messages for one member ordered', async () => {
    const service = new TeamProvisioningService() as unknown as OpenCodeMemberSendQueuePort;
    const firstGate = deferred();
    const events: string[] = [];

    const first = service.sendOpenCodeMemberMessageToRuntimeSerialized({
      teamName: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      send: async () => {
        events.push('first:start');
        await firstGate.promise;
        events.push('first:end');
        return result('alice');
      },
    });
    const second = service.sendOpenCodeMemberMessageToRuntimeSerialized({
      teamName: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      send: async () => {
        events.push('second:start');
        return result('alice');
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('allows different members on the same runtime lane to send concurrently', async () => {
    const service = new TeamProvisioningService() as unknown as OpenCodeMemberSendQueuePort;
    const aliceGate = deferred();
    const tomGate = deferred();
    const events: string[] = [];

    const alice = service.sendOpenCodeMemberMessageToRuntimeSerialized({
      teamName: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      send: async () => {
        events.push('alice:start');
        await aliceGate.promise;
        return result('alice');
      },
    });
    const tom = service.sendOpenCodeMemberMessageToRuntimeSerialized({
      teamName: 'team-a',
      laneId: 'primary',
      memberName: 'tom',
      send: async () => {
        events.push('tom:start');
        await tomGate.promise;
        return result('tom');
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['alice:start', 'tom:start']);
    aliceGate.resolve();
    tomGate.resolve();
    await Promise.all([alice, tom]);
  });
});
