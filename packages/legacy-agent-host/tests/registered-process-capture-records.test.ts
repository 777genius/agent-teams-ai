import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProcessCapture } from '../dist/process/validateProcessRecords.js';
import type { DarwinRegisteredProcessCapture, LinuxRegisteredProcessCapture, LinuxWarmRegisteredProcessCapture, RegisteredProcessCapture } from '../dist/process/registeredProcessContracts.js';
const legacy = (): DarwinRegisteredProcessCapture => ({
  version: 1, registrar: { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', generation: '1' },
  root: { auditToken: [501,501,20,501,20,1000,100,2], sessionId: 1000, bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: '24G90' },
  target: { auditToken: [501,501,20,501,20,1001,100,3], sessionId: 1000, bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: '24G90' },
});
test('Linux pidfs records preserve original identity; reading Darwin v1/v2 never rewrites their bytes', () => {
  const before = legacy();
  const bytes = JSON.stringify(before);
  const v2: DarwinRegisteredProcessCapture = { ...legacy(), version: 2, admission: 'live-ancestry-v1',
    target: { ...legacy().target, sessionId: 2000 } };
  const v2Bytes = JSON.stringify(v2);
  const linux: LinuxRegisteredProcessCapture = { version: 3, platform: 'linux', registrar: before.registrar,
    root: { pid: 1000, sessionId: 1000, pidfdId: '18446744073709551613', pidNamespaceId: '4026531836', bootId: before.root.bootId },
    target: { pid: 1001, sessionId: 2000, pidfdId: '18446744073709551614', pidNamespaceId: '4026531836', bootId: before.root.bootId } };
  validateProcessCapture(linux); validateProcessCapture(before); validateProcessCapture(v2);
  assert.equal(JSON.stringify(before), bytes); assert.equal(JSON.stringify(v2), v2Bytes);
  for (const target of [
    { ...linux.target, pidfdId: linux.root.pidfdId },
    { ...linux.target, pidfdId: '18446744073709551616' },
    { ...linux.target, pidNamespaceId: '4026531837' },
    { ...linux.target, bootId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  ]) assert.throws(() => validateProcessCapture({ ...linux, target }), /hold/);
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
test('warm records are strict owner-local references and never accept serialized pidfd authority', () => {
  const old = legacy();
  const capture: LinuxWarmRegisteredProcessCapture = { version: 4, platform: 'linux', admission: 'owner-pidfd-v1',
    ownerInstance: '11111111-1111-4111-8111-111111111111', captureKey: '22222222-2222-4222-8222-222222222222',
    registrar: old.registrar,
    root: { pid: 1000, sessionId: 1000, pidNamespaceId: '4026531836', bootId: old.root.bootId },
    target: { pid: 1001, sessionId: 2000, pidNamespaceId: '4026531836', bootId: old.root.bootId } };
  const bytes = JSON.stringify(capture); validateProcessCapture(capture);
  assert.equal(JSON.stringify(capture), bytes);
  for (const patch of [{ ownerInstance: '1000' }, { captureKey: undefined }, { fd: 12 },
    { admission: 'pid-and-start-ticks' }, { target: { ...capture.target, pidfdId: '12' } },
    { target: { ...capture.target, pidNamespaceId: '4026531837' } },
    { registrar: { ...capture.registrar, owner: 'other' } }])
    assert.throws(() => validateProcessCapture({ ...capture, ...patch } as RegisteredProcessCapture), /hold/);
});
