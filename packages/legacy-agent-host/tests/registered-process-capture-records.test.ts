import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProcessCapture } from '../dist/process/validateProcessRecords.js';
import type { RegisteredProcessCapture } from '../dist/process/registeredProcessContracts.js';
const legacy = (): RegisteredProcessCapture => ({
  version: 1, registrar: { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', generation: '1' },
  root: { auditToken: [501,501,20,501,20,1000,100,2], sessionId: 1000, bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: '24G90' },
  target: { auditToken: [501,501,20,501,20,1001,100,3], sessionId: 1000, bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: '24G90' },
});
test('v1 same-session remains compatible; cross-session needs an explicit private v2 admission', () => {
  validateProcessCapture(legacy());
  const cross = legacy(); cross.target.sessionId = 2000;
  assert.throws(() => validateProcessCapture(cross), /hold/);
  const admitted: RegisteredProcessCapture = { ...cross, version: 2, admission: 'live-ancestry-v1' };
  validateProcessCapture(admitted);
  for (const patch of [
    { admission: 'numeric-parent' }, { admission: undefined }, { version: 1 },
    { target: { ...admitted.target, sessionId: 1000 } },
    { target: { ...admitted.target, sessionId: 1001 } },
    { root: { ...admitted.root, sessionId: 2000 } },
    { target: { ...admitted.target, bootId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } },
    { target: { ...admitted.target, auditToken: admitted.root.auditToken } },
  ]) assert.throws(() => validateProcessCapture({ ...admitted, ...patch } as RegisteredProcessCapture), /hold/);
});
