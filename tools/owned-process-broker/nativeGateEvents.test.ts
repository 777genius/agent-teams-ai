import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, it } from 'vitest';

import { encodeFrame, FrameDecoder, Op } from '../../src/main/utils/ownedProcess/codec';
import { createNativeGateEvents } from './nativeGateEvents';
import { createFixtureOutputCollector } from './nativeGateOutput';

describe('native gate asynchronous callback failures', () => {
  // Regression: an actual streaming parse/decoder exception must reject the scenario and
  // execute its owned finally cleanup, even after an earlier readiness promise settled.
  for (const mode of ['fixture-json', 'protocol-frame', 'diagnostic'] as const) {
    it(`${mode} callback rejects the awaited scenario and reaches cleanup`, async () => {
      const events = createNativeGateEvents();
      const stream = new EventEmitter();
      const output = createFixtureOutputCollector();
      const generation = '11111111-1111-4111-8111-111111111111';
      const decoder = new FrameDecoder(generation);
      const diagnosticFailure = new Error('Diagnostic callback failure');
      stream.on(
        'data',
        events.guard((chunk: Buffer) => {
          if (mode === 'fixture-json') output.push(chunk);
          else if (mode === 'protocol-frame') decoder.push(chunk, () => undefined);
          else throw diagnosticFailure;
        })
      );
      const observations: string[] = [];
      const scenario = (async (): Promise<void> => {
        try {
          await events.wait(Promise.resolve());
          observations.push('ready');
          const chunk =
            mode === 'fixture-json'
              ? Buffer.from('{"children":invalid}\n')
              : encodeFrame({
                  opcode: Op.prepared,
                  requestId: 1n,
                  generation,
                  payload: Buffer.alloc(0),
                });
          if (mode === 'protocol-frame') chunk.writeUInt16LE(99, 4);
          assert.doesNotThrow(() => stream.emit('data', chunk));
          await events.wait(new Promise<void>(() => undefined));
          observations.push('released');
        } finally {
          observations.push('owned-cleanup');
        }
      })();
      if (mode === 'diagnostic') await assert.rejects(scenario, diagnosticFailure);
      else
        await assert.rejects(
          scenario,
          mode === 'fixture-json' ? SyntaxError : /Invalid protocol frame/u
        );
      assert.deepEqual(observations, ['ready', 'owned-cleanup']);
    });
  }
});

describe('finite I386 child observation decoding', () => {
  it('uses the actual private decoder and refuses incomplete, foreign or handled late observations', () => {
    const source = readFileSync(new URL('./nativeDebugServiceScenario.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const header = 'function readI386Observations(bytes: Buffer) {';
    const qualifier = 'function qualifyI386Observations(rows: ReturnType<typeof readI386Observations>, target: { pid: number; birth: string }) {';
    const rootQualifier = 'function qualifyI386RootObservations(rows: ReturnType<typeof readI386Observations>, root: { pid: number; birth: string }) {';
    const start = source.indexOf(header), end = source.indexOf('\n}\n\n/** Unstaged TEST binary only.', start);
    assert.ok(start >= 0 && start === source.lastIndexOf(header) && end > start);
    assert.ok(source.indexOf(qualifier, start) > start && source.indexOf(qualifier) === source.lastIndexOf(qualifier));
    assert.ok(source.indexOf(rootQualifier, start) > start && source.indexOf(rootQualifier) === source.lastIndexOf(rootQualifier));
    const actual = source.slice(start, end + 2).replace(header, 'function readI386Observations(bytes) {')
      .replace(qualifier, 'function qualifyI386Observations(rows, target) {')
      .replace(rootQualifier, 'function qualifyI386RootObservations(rows, root) {');
    const observed = runInNewContext(`(() => { ${actual}; return { read: readI386Observations, qualify: qualifyI386Observations, qualifyRoot: qualifyI386RootObservations }; })()`,
      { assert, Buffer }) as { read(bytes: Buffer): unknown; qualify(rows: unknown, child: { pid: number; birth: string }): unknown;
        qualifyRoot(rows: unknown, root: { pid: number; birth: string }): unknown };
    const read = (bytes: Buffer, child: { pid: number; birth: string }) => observed.qualify(observed.read(bytes), child);
    const child = { pid: 222, birth: 'bbbbbbbbbbbbbbbb' };
    const rows = [
      { pid: 111, birth: 'aaaaaaaaaaaaaaaa', code: 0x80000003, firstChance: 1, handled: 1 },
      { pid: 111, birth: 'aaaaaaaaaaaaaaaa', code: 0x4000001f, firstChance: 1, handled: 1 },
      { ...child, code: 0x80000003, firstChance: 1, handled: 1 },
      { ...child, code: 0x4000001f, firstChance: 1, handled: 1 },
      { ...child, code: 0x80000003, firstChance: 1, handled: 0 },
      { ...child, code: 0x4000001f, firstChance: 1, handled: 0 },
    ];
    const bytes = Buffer.alloc(rows.length * 32);
    rows.forEach((row, index) => {
      const offset = index * 32;
      bytes.writeUInt32LE(1, offset); bytes.writeUInt32LE(index + 1, offset + 4);
      bytes.writeUInt32LE(row.pid, offset + 8); bytes.writeBigUInt64LE(BigInt(`0x${row.birth}`), offset + 12);
      bytes.writeUInt32LE(row.code, offset + 20); bytes.writeUInt32LE(row.firstChance, offset + 24); bytes.writeUInt32LE(row.handled, offset + 28);
    });
    assert.deepEqual(JSON.parse(JSON.stringify(read(bytes, child))), rows);
    const childOnly = Buffer.from(bytes.subarray(2 * 32));
    for (let index = 0; index < 4; index++) childOnly.writeUInt32LE(index + 1, index * 32 + 4);
    assert.equal((read(childOnly, child) as unknown[]).length, 4, 'Other child observations are not a new cmd acceptance oracle');
    const extraChild = Buffer.concat([bytes, bytes.subarray(5 * 32)]);
    extraChild.writeUInt32LE(7, 6 * 32 + 4);
    assert.throws(() => read(extraChild, child), 'A fifth observation for the same retained child cannot qualify');
    const refusedLate = Buffer.from(bytes); refusedLate.writeUInt32LE(1, 4 * 32 + 28);
    assert.ok(observed.read(refusedLate), 'Closed counterexample facts survive before qualification fails');
    assert.throws(() => read(refusedLate, child));
    const translated = Buffer.from(bytes); translated.writeUInt32LE(0x4000001f, 4 * 32 + 20);
    assert.equal((read(translated, child) as unknown[]).length, 6, 'Actual late debugger codes are retained without assuming a WOW64 translation rule');
    for (const foreign of [{ ...child, pid: 333 }, { ...child, birth: 'cccccccccccccccc' }])
      assert.throws(() => read(bytes, foreign));
    const refusals: Array<(value: Buffer) => Buffer> = [
      () => Buffer.alloc(0), value => value.subarray(0, -1), value => value.subarray(0, -32),
      value => Buffer.concat([value, Buffer.alloc(32)]), () => Buffer.alloc(513),
      value => { value.writeUInt32LE(2, 0); return value; },
      value => { value.writeUInt32LE(2, 4); return value; },
      value => { value.writeUInt32LE(0, 8); return value; },
      value => { value.writeBigUInt64LE(0n, 12); return value; },
      value => { value.writeUInt32LE(333, 2 * 32 + 8); return value; },
      value => { value.writeUInt32LE(0x4000001f, 2 * 32 + 20); return value; },
      value => { value.writeUInt32LE(0x80000003, 3 * 32 + 20); return value; },
      value => { value.writeUInt32LE(0, 4 * 32 + 24); return value; },
      value => { value.writeUInt32LE(1, 4 * 32 + 28); return value; },
      value => { value.writeUInt32LE(0xc0000005, 5 * 32 + 20); return value; },
      value => { value.writeUInt32LE(2, 5 * 32 + 24); return value; },
    ];
    for (const refuse of refusals) assert.throws(() => read(refuse(Buffer.from(bytes)), child));

    const root = { pid: 444, birth: 'dddddddddddddddd' }, rootBytes = Buffer.from(childOnly);
    for (let index = 0; index < 4; index++) {
      rootBytes.writeUInt32LE(root.pid, index * 32 + 8);
      rootBytes.writeBigUInt64LE(BigInt(`0x${root.birth}`), index * 32 + 12);
    }
    const readRoot = (value: Buffer, identity = root) => observed.qualifyRoot(observed.read(value), identity);
    assert.deepEqual(JSON.parse(JSON.stringify(readRoot(rootBytes))), rows.slice(2).map(row => ({ ...row, ...root })));
    assert.throws(() => readRoot(childOnly), 'The real child trace cannot stand in for the prepared root');
    for (const foreign of [{ ...root, pid: 445 }, { ...root, birth: 'eeeeeeeeeeeeeeee' }])
      assert.throws(() => readRoot(rootBytes, foreign));
    for (const extra of [bytes.subarray(0, 32), rootBytes.subarray(3 * 32)]) {
      const extended = Buffer.concat([rootBytes, extra]);
      extended.writeUInt32LE(5, 4 * 32 + 4);
      assert.ok(observed.read(extended), 'Closed extra facts survive before root-only qualification fails');
      assert.throws(() => readRoot(extended), 'A foreign or fifth matching row cannot qualify the childless direct root');
    }
    const translatedRoot = Buffer.from(rootBytes);
    translatedRoot.writeUInt32LE(0x4000001f, 2 * 32 + 20);
    assert.equal((readRoot(translatedRoot) as Array<{ code: number }>)[2]!.code, 0x4000001f,
      'Keep the actual later I386 code without inventing a native-code ordering rule');
    const rootRefusals: Array<(value: Buffer) => Buffer> = [
      value => value.subarray(0, -1),
      value => { value.writeUInt32LE(2, 0); return value; },
      value => { value.writeUInt32LE(445, 2 * 32 + 8); return value; },
      value => { value.writeBigUInt64LE(0xeeeeeeeeeeeeeeeen, 3 * 32 + 12); return value; },
      value => { value.writeUInt32LE(0x4000001f, 20); return value; },
      value => { value.writeUInt32LE(0, 2 * 32 + 24); return value; },
      value => { value.writeUInt32LE(1, 2 * 32 + 28); return value; },
      value => { value.writeUInt32LE(0xc0000005, 3 * 32 + 20); return value; },
    ];
    for (const refuse of rootRefusals) assert.throws(() => readRoot(refuse(Buffer.from(rootBytes))));
  });
});
