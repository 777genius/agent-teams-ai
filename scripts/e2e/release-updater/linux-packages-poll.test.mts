import assert from 'node:assert/strict';
import { test } from 'node:test';

import { automaticNoUpdatePollResult } from './linux-packages-poll.mts';

import type { AutomaticFeedProof } from './linux-packages-seal.mts';

const owner = { pid: 410, group: 410, start: '246406', state: 'S' };
const version = '2.17.10';
const complete: AutomaticFeedProof = {
  pid: 410,
  start: '246406',
  events: [{ type: 'update-not-available', version }],
  statuses: [{ type: 'not-available' }],
  installerGets: 0,
};
void test('renderer terminal after stale main snapshot remains pending until both actual observations qualify', () => {
  const stale = { ...complete, events: [{ type: 'checking-for-update' }] };
  assert.equal(automaticNoUpdatePollResult(owner, version, stale), null);
  assert.equal(automaticNoUpdatePollResult(owner, version, complete), complete);
});
void test('main-only, wrong-version and absent terminal evidence remain pending', () => {
  for (const proof of [
    { ...complete, statuses: [] },
    { ...complete, events: [{ type: 'update-not-available', version: '2.17.1' }] },
    { ...complete, events: [], statuses: [] },
  ])
    assert.equal(automaticNoUpdatePollResult(owner, version, proof), null);
});
void test('main and renderer errors fail immediately even while other observations are pending', () => {
  for (const proof of [
    { ...complete, events: [{ type: 'error', message: 'network failed' }], statuses: [] },
    { ...complete, events: [], statuses: [{ type: 'error', error: 'IPC failed' }] },
    { ...complete, events: [], statuses: [{ type: 'checking', error: 'IPC failed' }] },
  ])
    assert.throws(() => automaticNoUpdatePollResult(owner, version, proof), /reported error/);
});
void test('both terminal observations cannot bypass PID generation or installer custody', () => {
  for (const proof of [
    { ...complete, pid: 999 },
    { ...complete, start: 'reused' },
    { ...complete, installerGets: 1 },
  ])
    assert.throws(() => automaticNoUpdatePollResult(owner, version, proof));
});
