import { describe, expect, it, vi } from 'vitest';

import { OpenCodeMemberSendSerializer } from '../TeamProvisioningOpenCodeMemberSendSerialization';

import type { OpenCodeTeamRuntimeMessageResult } from '../../runtime';

describe('OpenCodeMemberSendSerializer', () => {
  it('builds relay and lane keys with existing trim behavior', () => {
    const serializer = createSerializer();

    expect(serializer.getMemberRelayKey('team-a', ' member-a ')).toBe('team-a:member-a');
    expect(serializer.getOpenCodeMemberRelayKey('team-a', ' member-a ')).toBe(
      'opencode:team-a:member-a'
    );
    expect(serializer.getOpenCodeMemberSendLaneKey('team-a', ' lane-a ')).toBe(
      'opencode-send:team-a:lane-a'
    );
  });

  it('chains sends per lane while allowing other lanes to proceed', async () => {
    const { serializer } = createSerializerWithMap();
    const firstGate = createDeferred<OpenCodeTeamRuntimeMessageResult>();
    const firstSend = vi.fn(() => firstGate.promise);
    const secondSend = vi.fn(() => Promise.resolve(resultFor('second')));
    const otherLaneSend = vi.fn(() => Promise.resolve(resultFor('other')));

    const first = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-a',
      send: firstSend,
    });
    const second = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-a',
      send: secondSend,
    });
    const otherLane = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-b',
      send: otherLaneSend,
    });

    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).not.toHaveBeenCalled();
    await expect(otherLane).resolves.toMatchObject({ memberName: 'other' });
    expect(otherLaneSend).toHaveBeenCalledTimes(1);

    firstGate.resolve(resultFor('first'));

    await expect(first).resolves.toMatchObject({ memberName: 'first' });
    await expect(second).resolves.toMatchObject({ memberName: 'second' });
    expect(secondSend).toHaveBeenCalledTimes(1);
  });

  it('does not let a failed previous send block later deliveries on the same lane', async () => {
    const serializer = createSerializer();
    const first = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-a',
      send: () => Promise.reject(new Error('send failed')),
    });
    const second = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-a',
      send: () => Promise.resolve(resultFor('second')),
    });

    await expect(first).rejects.toThrow('send failed');
    await expect(second).resolves.toMatchObject({ memberName: 'second' });
  });

  it('cleans an in-flight lane only when the current work is still registered', async () => {
    const { serializer, inFlightByLane } = createSerializerWithMap();
    const laneKey = serializer.getOpenCodeMemberSendLaneKey('team-a', 'lane-a');
    const firstGate = createDeferred<OpenCodeTeamRuntimeMessageResult>();
    const secondGate = createDeferred<OpenCodeTeamRuntimeMessageResult>();
    const secondSend = vi.fn(() => secondGate.promise);

    const first = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-a',
      send: () => firstGate.promise,
    });
    const second = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-a',
      send: secondSend,
    });

    expect(inFlightByLane.has(laneKey)).toBe(true);

    firstGate.resolve(resultFor('first'));
    await expect(first).resolves.toMatchObject({ memberName: 'first' });
    await waitFor(() => expect(secondSend).toHaveBeenCalledTimes(1));
    expect(inFlightByLane.has(laneKey)).toBe(true);

    secondGate.resolve(resultFor('second'));
    await expect(second).resolves.toMatchObject({ memberName: 'second' });
    expect(inFlightByLane.has(laneKey)).toBe(false);
  });
});

function createSerializer(): OpenCodeMemberSendSerializer {
  return createSerializerWithMap().serializer;
}

function createSerializerWithMap(): {
  serializer: OpenCodeMemberSendSerializer;
  inFlightByLane: Map<string, Promise<OpenCodeTeamRuntimeMessageResult>>;
} {
  const inFlightByLane = new Map<string, Promise<OpenCodeTeamRuntimeMessageResult>>();
  return {
    serializer: new OpenCodeMemberSendSerializer({ inFlightByLane }),
    inFlightByLane,
  };
}

function resultFor(memberName: string): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName,
    diagnostics: [],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 9) {
        throw error;
      }
      await Promise.resolve();
    }
  }
}
