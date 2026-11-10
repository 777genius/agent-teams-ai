import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

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
