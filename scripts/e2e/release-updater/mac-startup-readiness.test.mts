import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitMacStartupReady } from './mac-startup-readiness.mts';
import type { Cdp } from './cdp.mts';
const pending = {
  phase: 'services',
  message: 'Preparing app services...',
  ready: false,
  startedAt: 1,
  updatedAt: 2,
  error: null,
};
const ready = { ...pending, phase: 'ready', message: 'Ready', ready: true };
function fake(values: unknown[], calls: string[]): Pick<Cdp, 'send'> {
  return {
    send<T>(_method: string, params: Record<string, unknown> = {}) {
      calls.push(String(params.expression));
      return Promise.resolve(values.shift() as T);
    },
  };
}
const result = (value: unknown) => ({ result: { value } });
void test('both immutable versions wait actual public readiness before any config read or mutation', async () => {
  for (const version of ['2.17.1', '2.17.10']) {
    const calls: string[] = [];
    let configRegistered = false;
    let configReads = 0;
    const statuses = [pending, ready];
    const cdp: Pick<Cdp, 'send'> = {
      send<T>(_method: string, params: Record<string, unknown> = {}) {
        const expression = String(params.expression);
        calls.push(expression);
        if (expression.includes('config.get')) {
          if (!configRegistered)
            return Promise.reject(new Error("No handler registered for 'config:get'"));
          configReads += 1;
          return Promise.resolve(result({ general: {} }) as T);
        }
        if (expression.startsWith('typeof')) return Promise.resolve(result(true) as T);
        const status = statuses.shift();
        configRegistered = status?.ready === true;
        return Promise.resolve(result(status) as T);
      },
    };
    const receipt = await waitMacStartupReady(cdp, version, 100, 1);
    assert.deepEqual(receipt.observations, [pending, ready]);
    assert.equal(calls.length, 3);
    assert(calls.every((expression) => !expression.includes('config')));
    assert.equal(configReads, 0);
    await cdp.send('Runtime.evaluate', {
      expression: 'window.electronAPI.config.get()',
    });
    assert.equal(configReads, 1);
    assert.equal(calls.at(-1), 'window.electronAPI.config.get()');
  }
});
void test('missing API, startup failure, malformed status and other IPC errors fail without config fallback', async () => {
  for (const value of [
    result(false),
    result({ ...pending, phase: 'failed', error: 'services failed' }),
    result({ ...pending, error: 'failure' }),
    result({ ...pending, ready: 'yes' }),
    result({ ...ready, phase: 'services' }),
    {
      exceptionDetails: {
        text: "No handler registered for 'appStartup:getStatus'",
      },
      result: {},
    },
    { exceptionDetails: { text: 'unexpected IPC error' }, result: {} },
  ]) {
    const calls: string[] = [];
    const values =
      value.result && 'value' in value.result && value.result.value === false
        ? [value]
        : [result(true), value];
    await assert.rejects(waitMacStartupReady(fake(values, calls), '2.17.10', 100, 1));
    assert(calls.every((expression) => !expression.includes('config')));
  }
});
void test('permanent pending startup and a stalled CDP read stop at deadline', async () => {
  const calls: string[] = [];
  const cdp: Pick<Cdp, 'send'> = {
    send<T>(_method: string, params: Record<string, unknown> = {}) {
      calls.push(String(params.expression));
      return Promise.resolve(result(calls.length === 1 ? true : pending) as T);
    },
  };
  await assert.rejects(waitMacStartupReady(cdp, '2.17.1', 10, 1), /deadline exceeded/);
  const stalled: Pick<Cdp, 'send'> = {
    send<T>() {
      return new Promise<T>(() => undefined);
    },
  };
  await assert.rejects(waitMacStartupReady(stalled, '2.17.10', 10, 1), /deadline exceeded/);
});
