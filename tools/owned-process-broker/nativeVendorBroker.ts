import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import { encodeFrame, FrameDecoder, Op } from '@agent-teams/legacy-agent-host/owned-process';
import { timeout } from './nativeGateContext';
import type { BrokerTransportFactory, Frame, ProcessOwner } from '@agent-teams/legacy-agent-host/owned-process';
import type { NativeGateEvents } from './nativeGateEvents';

/**
 * TEST-only transport tap for the existing mode-2 opcode. Product preparation,
 * resume, whole-Job Stop, tree receipts and release still use the real port.
 * Only private request IDs are translated so one broker receives one sequence;
 * service replies never reach the product receipt decoder.
 */
export function nativeVendorBroker(options: {
  path: string; diagnosticPath: string; owner: ProcessOwner; events: NativeGateEvents;
  verify(): void; track(child: ChildProcess): void;
}) {
  const { events, owner } = options;
  let raw: ChildProcess | undefined;
  let channel: Duplex | undefined;
  let nextId = 0n;
  const originalIds = new Map<bigint, bigint>();
  const productIds = new Map<bigint, bigint>();
  const serviceReplies = new Map<bigint, { opcode: number; resolve(frame: Frame): void }>();
  let scopedCalls = 0;
  const factory: BrokerTransportFactory = {
    available(path) {
      assert.equal(path, options.path);
      options.verify();
      return true;
    },
    connect(path) {
      assert.equal(path, options.path);
      assert.equal(raw, undefined, 'One original TEST broker, never an attach/reconnect path');
      const diagnosticFd = openSync(options.diagnosticPath, 'wx');
      try {
        raw = spawn(path, [], { windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe', 'overlapped', diagnosticFd] });
      } finally { closeSync(diagnosticFd); }
      options.track(raw);
      const pipe = raw.stdio[3];
      assert.ok(pipe instanceof Duplex && raw.stdin && raw.stdout && raw.stderr);
      channel = pipe;
      const input = new FrameDecoder(owner.processGeneration);
      const output = new FrameDecoder(owner.processGeneration);
      const control = new Duplex({
        read() { pipe.resume(); },
        write(chunk: Buffer, _encoding, callback) {
          try {
            let selected: Frame | undefined;
            input.push(chunk, frame => {
              assert.equal(selected, undefined, 'One complete product frame per existing port write');
              selected = frame;
            });
            assert.ok(selected);
            const frame: Frame = selected;
            let translated = originalIds.get(frame.requestId);
            if (translated === undefined) {
              assert.ok(originalIds.size < 32);
              translated = ++nextId;
              originalIds.set(frame.requestId, translated);
              productIds.set(translated, frame.requestId);
            }
            pipe.write(encodeFrame({ ...frame, requestId: translated }), callback);
          } catch (error) { callback(error instanceof Error ? error : new Error('TEST frame translation failed')); }
        },
        final(callback) { pipe.end(callback); },
        destroy(error, callback) { pipe.destroy(); callback(error); },
      });
      pipe.on('data', events.guard((chunk: Buffer) => output.push(chunk, frame => {
        if (frame.opcode === Op.rootExit) {
          if (!control.push(encodeFrame(frame))) pipe.pause();
          return;
        }
        const original = productIds.get(frame.requestId);
        if (original !== undefined) {
          if (!control.push(encodeFrame({ ...frame, requestId: original }))) pipe.pause();
          return;
        }
        const selected = serviceReplies.get(frame.requestId);
        assert.ok(selected, 'Reply belongs to an original product or scoped TEST request');
        assert.equal(frame.opcode, selected.opcode, 'Exact scoped native response');
        serviceReplies.delete(frame.requestId);
        selected.resolve(frame);
      })));
      pipe.once('end', events.guard(() => { output.end(); control.push(null); }));
      pipe.on('error', error => control.destroy(error));
      raw.once('exit', events.guard(code => {
        const failure = readFileSync(options.diagnosticPath);
        assert.ok(failure.length === 0 || failure.length === 16);
        if (failure.length) console.error(JSON.stringify({ nativeVendorDebugFailure: {
          stage: failure.readUInt32LE(0), error: failure.readUInt32LE(4),
          event: failure.readUInt32LE(8), pid: failure.readUInt32LE(12),
        } }));
        assert.equal(code, 0);
        assert.equal(failure.length, 0, 'No swallowed debug-loop failure');
      }));
      const child = raw;
      return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, control,
        onFailure(callback) { child.on('error', callback); },
        onExit(callback) { child.on('exit', (code, signal) => callback({ code, signal })); } };
    },
  };
  async function request(payload: Buffer, opcode: number, id = ++nextId): Promise<Frame> {
    assert.ok(channel && scopedCalls++ < 4 && serviceReplies.size === 0);
    const response = new Promise<Frame>(resolve => serviceReplies.set(id, { opcode, resolve }));
    channel.write(encodeFrame({ opcode: Op.stop, requestId: id,
      generation: owner.processGeneration, payload }), events.guard((error?: Error | null) => {
      if (error) throw error;
    }));
    return timeout(events.wait(response));
  }
  return {
    factory,
    async stopService(service: { pid: number; birth: string }) {
      assert.ok(Number.isSafeInteger(service.pid) && service.pid > 0);
      assert.match(service.birth, /^[a-f0-9]{16}$/);
      const selected = Buffer.alloc(17);
      selected.writeUInt32LE(5000); selected[4] = 2;
      selected.writeUInt32LE(service.pid, 5);
      selected.writeBigUInt64LE(BigInt('0x' + service.birth), 9);
      const wrong = Buffer.from(selected);
      wrong.writeBigUInt64LE(BigInt('0x' + service.birth) ^ 1n, 9);
      await request(wrong, Op.failed);
      const stopId = nextId + 1n;
      const stopped = await request(selected, Op.stopped);
      assert.equal(stopped.payload.length, 26);
      assert.equal(stopped.payload[1], 1);
      assert.equal(stopped.payload.readUInt32LE(2), 0, 'Selected original nested Job is actually empty');
      assert.equal(stopped.payload.readBigUInt64LE(10), BigInt('0x' + service.birth));
      assert.equal(stopped.payload.readUInt32LE(18), 0);
      assert.equal(stopped.payload.readUInt32LE(22), 0);
      assert.deepEqual((await request(selected, Op.stopped, stopId)).payload, stopped.payload,
        'Original lost-ACK replay is idempotent without new native dispatch');
      return { originalBirth: service.birth, activeProcesses: 0, duplicateAckMatched: true };
    },
  };
}
