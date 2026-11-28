// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';

const request: BackendOperationRequest = {
  handle: { handleId: 'TEST-handle' },
  commandId: 'TEST-read',
  operation: 'runtime.checkpoints.read',
  payload: { memberId: 'TEST-lead', expectedGeneration: 'TEST-source' },
};
const value = {
  memberId: 'TEST-lead',
  sourceGeneration: 'TEST-source',
  status: 'owner-eligible',
  reason: 'native-backing-unverified',
  nativeBacking: 'unverified',
  checkpoints: [
    {
      checkpointId: 'TEST-checkpoint',
      reference: `cp1-${'a'.repeat(64)}`,
      status: 'owner-eligible',
      reason: 'native-backing-unverified',
    },
  ],
};

describe('finite checkpoint availability query', () => {
  it('requires exact member/generation without private caller selectors', () => {
    expect(parseBackendOperation(request)).toEqual(request);
    for (const payload of [
      { memberId: 'TEST-lead' },
      { ...request.payload, expectedGeneration: '' },
      { ...request.payload, nativePath: '/TEST/private' },
      { ...request.payload, reference: value.checkpoints[0]!.reference },
    ])
      expect(() => parseBackendOperation({ ...request, payload })).toThrow();
  });
  it('projects only bounded exact-source references, rejecting invented native compatibility', () => {
    expect(
      projectBackendResult(request, {
        ok: true,
        value: { ...value, nativeSessionId: 'TEST-private', payload: { path: '/TEST/private' } },
      })
    ).toEqual({ ok: true, value });
    for (const changed of [
      { ...value, sourceGeneration: 'TEST-other' },
      { ...value, memberId: 'TEST-other' },
      { ...value, nativeBacking: 'verified' },
      { ...value, reason: '/TEST/private-error' },
      { ...value, checkpoints: [] },
      { ...value, checkpoints: Array(129).fill(value.checkpoints[0]) },
      { ...value, checkpoints: [value.checkpoints[0], value.checkpoints[0]] },
      { ...value, checkpoints: [{ ...value.checkpoints[0], reference: '/TEST/native-path' }] },
    ])
      expect(() => projectBackendResult(request, { ok: true, value: changed })).toThrow();
  });
  it('routes query through the existing owner control lane, with no mutation or lookup', async () => {
    const router = {
      request: vi.fn<BackendOwnerRouter['request']>().mockResolvedValue({ ok: true, value }),
      lookup: vi.fn<BackendOwnerRouter['lookup']>(),
    };
    expect(await new BackendOperationsFacade(router).invoke(request)).toEqual({ ok: true, value });
    expect(router.request).toHaveBeenCalledExactlyOnceWith(request.handle, {
      commandId: request.commandId,
      method: request.operation,
      payload: request.payload,
      control: true,
    });
    expect(router.lookup).not.toHaveBeenCalled();
  });
});
