import { describe, expect, it } from 'vitest';

import {
  parseRuntimeStopRequest,
  validateRuntimeStopData,
  validateRuntimeStopReceipt,
} from './OpenCodeRuntimeStopProtocol';

const request = parseRuntimeStopRequest({
  contractVersion: 1,
  originalRequestId: 'original',
  idempotencyKey: 'key',
  target: {
    teamId: 'test-team',
    laneId: 'primary',
    runId: 'run',
    projectPath: '/test-only/opencode-stop-protocol',
    capabilitySnapshotId: `opencode:${'a'.repeat(32)}`,
    expectedBehaviorFingerprint: 'b'.repeat(64),
    members: [{ memberName: 'alice', sessionId: 'session' }],
  },
});
const data = {
  runId: 'run',
  stopped: false,
  members: { alice: { sessionId: 'session', stopped: false, diagnostics: ['abort unconfirmed'] } },
  warnings: ['opencode_stop_status_unconfirmed'],
  diagnostics: [{ code: 'stop', severity: 'error', message: 'unconfirmed' }],
  idempotencyKey: 'key',
  manifestHighWatermark: null,
  runtimeStoreManifestHighWatermark: 0,
};
const receipt = {
  request,
  status: 'completed',
  data,
  runtime: {
    providerId: 'opencode',
    capabilitySnapshotId: request.target.capabilitySnapshotId,
    binaryPath: null,
    binaryFingerprint: null,
    version: null,
  },
  binding: [
    {
      memberName: 'alice',
      sessionId: 'session',
      hostKey: 'host',
      createdAt: 'original-generation',
    },
  ],
};

describe('runtime Stop nested contract validation', () => {
  it.each([
    ['manifestHighWatermark'],
    ['runtimeStoreManifestHighWatermark'],
    ['manifestHighWatermark', 'runtimeStoreManifestHighWatermark'],
  ])('accepts omitted optional watermarks %j in results and receipts', (...omitted) => {
    const value: Record<string, unknown> = { ...data };
    for (const field of omitted) delete value[field];
    expect(validateRuntimeStopData(value, request)).toEqual(value);
    expect(validateRuntimeStopReceipt({ ...receipt, data: value }, request).data).toEqual(value);
  });

  it.each(['manifestHighWatermark', 'runtimeStoreManifestHighWatermark'])(
    'rejects malformed optional %s',
    (field) => {
      for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', {}, false]) {
        expect(() => validateRuntimeStopData({ ...data, [field]: invalid }, request)).toThrow();
      }
      for (const valid of [undefined, null, 0, Number.MAX_SAFE_INTEGER]) {
        const value = { ...data, [field]: valid };
        expect(validateRuntimeStopData(value, request)).toEqual(value);
      }
    }
  );

  it.each(['info', 'warning', 'error'])(
    'accepts string severity %s and string warning lists',
    (severity) => {
      const value = { ...data, diagnostics: [{ ...data.diagnostics[0], severity }] };
      expect(validateRuntimeStopData(value, request)).toEqual(value);
    }
  );
  it.each([
    { warnings: [{ message: 'wrong wire shape' }] },
    { diagnostics: [{ code: 'stop', severity: ['error'], message: 'coercible but invalid' }] },
    { diagnostics: [{ code: 1, severity: 'error', message: 'invalid' }] },
    { diagnostics: [{ code: 'stop', severity: 'error', message: ['invalid'] }] },
    { stopped: true },
    { runId: 'successor' },
    { idempotencyKey: 'new-key' },
    { members: {} },
    { members: { alice: { sessionId: 'successor', stopped: false, diagnostics: [] } } },
    { members: { alice: { sessionId: 'session', stopped: false, diagnostics: [7] } } },
    { manifestHighWatermark: -1 },
    { runtimeStoreManifestHighWatermark: 0.5 },
  ])('rejects malformed nested domain fields %j', (patch) => {
    expect(() => validateRuntimeStopData({ ...data, ...patch }, request)).toThrow();
    expect(() =>
      validateRuntimeStopReceipt({ ...receipt, data: { ...data, ...patch } }, request)
    ).toThrow();
  });
  it.each([
    { request: { ...request, originalRequestId: 'new-request' } },
    { request: { ...request, idempotencyKey: 'new-key' } },
    { runtime: { ...receipt.runtime, providerId: 'other' } },
    { runtime: { ...receipt.runtime, capabilitySnapshotId: 'wrong-capability' } },
    { runtime: { ...receipt.runtime, version: [] } },
    { binding: [] },
    { binding: [{ ...receipt.binding[0], sessionId: 'successor' }] },
    { binding: [{ ...receipt.binding[0], hostKey: null }] },
    { binding: [{ ...receipt.binding[0], createdAt: '' }] },
    { status: 'inflight' },
  ])('rejects mismatched receipt authority %j', (patch) => {
    expect(() => validateRuntimeStopReceipt({ ...receipt, ...patch }, request)).toThrow();
  });
});
