import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { encodeSelectedLaunchPhase, SELECTED_LAUNCH_MAXIMUM, SELECTED_LAUNCH_PHASE,
  writeSelectedLaunchPhase } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/selected-launch-phase';

// Transport tests only. These values are not admitted launch selections.
describe('selected-launch FD5 phase transport', () => {
  it('bounds the versioned aggregate before writing', () => {
    const frame = encodeSelectedLaunchPhase({ actual: 'input' }, { actual: 'event' });
    expect(frame.readUInt32BE(0)).toBe(0x48534c31);
    expect(frame.readUInt32BE(4)).toBe(frame.length - 8);
    expect(JSON.parse(frame.subarray(8).toString())).toEqual({
      contract: SELECTED_LAUNCH_PHASE, launch: { actual: 'input' }, sealed: { actual: 'event' },
    });
    expect(() => encodeSelectedLaunchPhase({ data: 'x'.repeat(SELECTED_LAUNCH_MAXIMUM) }, {})).toThrow('bound');
  });

  it('writes the prelude and preserves the same live Unix endpoint for later activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'selected-phase-r1014-'));
    const server = createServer();
    let peer: Socket | undefined, writer: Socket | undefined;
    try {
      server.listen(join(root, 'socket')); await once(server, 'listening');
      const accepted = once(server, 'connection');
      peer = connect(join(root, 'socket'));
      const received: Buffer[] = [];
      peer.on('data', part => received.push(Buffer.from(part)));
      const ended = once(peer, 'end');
      [writer] = await accepted as [Socket];
      const frame = encodeSelectedLaunchPhase({ retained: 'input' }, { retained: 'native-event' });
      const observed = await writeSelectedLaunchPhase(writer, frame, performance.now() + 5000);
      expect(observed.byteLength).toBe(frame.length);
      expect(writer.destroyed).toBe(false);
      writer.end('subsequent activation bytes');
      await ended;
      expect(Buffer.concat(received)).toEqual(Buffer.concat([frame, Buffer.from('subsequent activation bytes')]));
      const cancelled = new AbortController(); cancelled.abort();
      await expect(writeSelectedLaunchPhase(writer, frame, performance.now() + 5000, cancelled.signal)).rejects.toThrow();
    } finally {
      peer?.destroy(); writer?.destroy(); server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
