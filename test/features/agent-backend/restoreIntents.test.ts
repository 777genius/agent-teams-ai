// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';

const request: BackendOperationRequest = {
  handle: { handleId: 'TEST-handle' },
  commandId: 'TEST-read',
  operation: 'team.launch.restorations.read',
  payload: { launchId: 'TEST-launch' },
};
const original = {
  commandId: 'TEST-original-command',
  memberId: 'TEST-member',
  reference: `cp1-${'a'.repeat(64)}`,
  sourceGeneration: 'TEST-source',
  selectedGeneration: 'TEST-selected',
  current: true,
  phase: 'unopened',
  custody: 'released',
  attached: false,
};
const value = {
  preparations: [],
  launchId: 'TEST-launch',
  rosterRevision: 'TEST-revision',
  restorations: [original],
};

it('restore reads require explicit launch scope and route through control lane', async () => {
  expect(parseBackendOperation(request)).toEqual(request);
  for (const payload of [
    {},
    { launchId: '' },
    { ...request.payload, nativeSessionId: 'TEST-private' },
  ])
    expect(() => parseBackendOperation({ ...request, payload })).toThrow();
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
it('projects exact original identities without private binding/config payloads or inferred success', () => {
  expect(
    projectBackendResult(request, {
      ok: true,
      value: {
        ...value,
        restorations: [
          { ...original, binding: { sessionId: 'TEST-native' }, configRevision: '/TEST/private' },
        ],
      },
    })
  ).toEqual({ ok: true, value });
  expect(
    projectBackendResult(request, { ok: true, value: { ...value, restorations: [] } })
  ).toEqual({ ok: true, value: { ...value, restorations: [] } });
  for (const malformed of [
    { ...value, launchId: 'TEST-other' },
    { ...value, restorations: Array(65).fill(original) },
    { ...value, restorations: [original, original] },
    { ...value, restorations: [{ ...original, selectedGeneration: original.sourceGeneration }] },
    { ...value, restorations: [{ ...original, phase: 'succeeded' }] },
    { ...value, restorations: [{ ...original, phase: 'unavailable', custody: 'released' }] },
    { ...value, restorations: [{ ...original, reference: '/TEST/native-history' }] },
  ])
    expect(() => projectBackendResult(request, { ok: true, value: malformed })).toThrow();
});
