import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  createHostProcessControls,
  OriginalProcessStopUnknown,
} from '../../../src/features/agent-backend/renderer/createHostProcessControls';
const ref = 'p1:TEST-process:' + 'a'.repeat(64);
const completed = (commandId: string) => ({
  commandId,
  operation: 'terminate',
  originalProcessRef: ref,
  phase: 'completed',
  state: { phase: 'completed', native: 'observed-absent', signalAccepted: 'unknown' },
});
test('lost native dispatch ACK uses exact original lookup; cold row retry never dispatches another terminate', async () => {
  const calls: {
    operation: string;
    commandId: string;
    payload: { originalCommandId?: string; processRef?: string };
  }[] = [];
  let finished = false;
  const options = {
    backend: {
      async invoke(request: (typeof calls)[number]) {
        calls.push(request);
        if (request.operation === 'process.terminate') throw Error('TEST transport loss');
        return { ok: true, value: finished ? completed(request.payload.originalCommandId!) : null };
      },
    },
    captureScope: () => () => true,
    resolve: async () => ({ handle: { handleId: 'TEST-handle' }, assertCurrent() {} }),
    invalidateReads() {},
  };
  const stop = createHostProcessControls(options);
  let original: OriginalProcessStopUnknown | undefined;
  try {
    await stop('host-team:TEST-handle', 1001, { processRef: ref });
  } catch (error) {
    assert.ok(error instanceof OriginalProcessStopUnknown);
    original = error;
  }
  assert.ok(original);
  assert.equal(calls.filter((row) => row.operation === 'process.terminate').length, 1);
  assert.equal(calls[1]!.payload.originalCommandId, original.original.commandId);
  finished = true;
  await createHostProcessControls(options)('host-team:TEST-handle', 9999, {
    processRef: ref,
    originalCommandId: original.original.commandId,
  });
  assert.equal(calls.filter((row) => row.operation === 'process.terminate').length, 1);
  assert.equal(calls.at(-1)!.payload.originalCommandId, original.original.commandId);
});
test('signal accepted is not success until original incarnation absence is observed', async () => {
  const operations: string[] = [];
  let original = '';
  const stop = createHostProcessControls({
    backend: {
      async invoke(request) {
        operations.push(request.operation);
        if (request.operation === 'process.terminate') {
          original = request.commandId;
          return {
            ok: true,
            value: {
              commandId: original,
              operation: 'terminate',
              originalProcessRef: ref,
              phase: 'held',
              state: { phase: 'requested', native: 'accepted' },
            },
          };
        }
        return { ok: true, value: completed(original) };
      },
    },
    captureScope: () => () => true,
    resolve: async () => ({ handle: { handleId: 'TEST-handle' }, assertCurrent() {} }),
    invalidateReads() {},
  });
  await stop('host-team:TEST-handle', 1001, { processRef: ref });
  assert.deepEqual(operations, ['process.terminate', 'process.lookup']);
});
test('context revocation after dispatch stops all follow-up queries without losing original identity', async () => {
  let current = true,
    calls = 0;
  const stop = createHostProcessControls({
    backend: {
      async invoke() {
        calls++;
        current = false;
        return { ok: true, value: null };
      },
    },
    captureScope: () => () => current,
    resolve: async () => ({ handle: { handleId: 'TEST-handle' }, assertCurrent() {} }),
    invalidateReads() {},
  });
  await assert.rejects(
    stop('host-team:TEST-handle', 1001, { processRef: ref }),
    (error) => error instanceof OriginalProcessStopUnknown && error.original.processRef === ref
  );
  assert.equal(calls, 1);
});
