// @vitest-environment node
import { expect, it } from 'vitest';

import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts/operations';

const request: BackendOperationRequest = {
  handle: { handleId: 'TEST-handle' },
  commandId: 'TEST-runtime-capabilities',
  operation: 'runtime.read',
  payload: { memberId: 'TEST-member' },
};
const snapshot = () => ({
  memberId: 'TEST-member',
  generation: 'TEST-current',
  phase: 'allocated',
  sealed: false,
  custody: 'owned',
  nativeReady: true,
  attached: true,
  inputs: [],
  interactions: [],
  attachmentCapabilities: {
    images: true,
    documents: true,
    textFiles: true,
    privatePath: '/TEST-private',
  },
});

it('projects only explicit native channel booleans from a current attached ready Runtime snapshot', () => {
  const result = projectBackendResult(request, { ok: true, value: snapshot() });
  expect(result).toMatchObject({
    ok: true,
    value: {
      attachmentCapabilities: { images: true, documents: true, textFiles: true },
    },
  });
  expect(JSON.stringify(result)).not.toContain('TEST-private');
});

it('rejects native channel claims for inactive snapshots or non-boolean channel values', () => {
  for (const patch of [
    { generation: undefined },
    { phase: 'closed' },
    { sealed: true },
    { custody: 'unknown' },
    { nativeReady: false },
    { attached: false },
    { attachmentCapabilities: { images: 'true', documents: false, textFiles: false } },
  ]) {
    expect(() =>
      projectBackendResult(request, { ok: true, value: { ...snapshot(), ...patch } })
    ).toThrow();
  }
});

it('keeps historical hosts without explicit channel metadata compatible and does not infer support', () => {
  const { attachmentCapabilities: _capabilities, ...legacy } = snapshot();
  const result = projectBackendResult(request, { ok: true, value: legacy });
  expect(result).toEqual({ ok: true, value: legacy });
});
