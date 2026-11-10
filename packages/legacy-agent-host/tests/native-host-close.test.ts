import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeNativeHostInput } from './fixtures/native-host.ts';

test('native fixture observes advertised disposal before signaling the original child', async () => {
  const original = { now: 0, endCalls: 0, signals: [] as number[], waits: [] as number[] };
  // Runtime may already be closed; final backup is still allowed to finish at 45 s.
  await closeNativeHostInput(
    {
      endInput() {
        original.endCalls++;
      },
      async waitExit(timeoutMs) {
        original.waits.push(timeoutMs);
        const deadline = original.now + timeoutMs;
        if (deadline >= 45_000) {
          original.now = 45_000;
          return true;
        }
        original.now = deadline;
        return false;
      },
      terminate() {
        original.signals.push(original.now);
      },
    },
    60_000
  );
  assert.equal(original.endCalls, 1);
  assert.equal(original.now, 45_000);
  assert.deepEqual(original.waits, [62_000]);
  assert.deepEqual(
    original.signals,
    [],
    'same original child finishes naturally within its contract'
  );
});

test('native fixture retains failure after one bounded original-child fallback', async () => {
  let now = 0,
    endCalls = 0;
  const signals: number[] = [];
  await assert.rejects(
    closeNativeHostInput(
      {
        endInput() {
          endCalls++;
        },
        async waitExit(timeoutMs) {
          now += timeoutMs;
          return false;
        },
        terminate() {
          signals.push(now);
        },
      },
      60_000
    ),
    /captured Host must confirm provider cleanup before exiting/
  );
  assert.equal(endCalls, 1);
  assert.deepEqual(signals, [62_000]);
  assert.equal(now, 74_000, 'unconfirmed exit remains a bounded failure');
});

test('native fixture refuses invalid disposal budgets before touching the original child', async () => {
  const effects: string[] = [];
  for (const invalid of [60_001, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    await assert.rejects(
      closeNativeHostInput(
        {
          endInput() {
            effects.push('end');
          },
          async waitExit() {
            effects.push('wait');
            return true;
          },
          terminate() {
            effects.push('signal');
          },
        },
        invalid
      ),
      /within the captured TeamHost contract/
    );
  }
  assert.deepEqual(effects, []);
});
