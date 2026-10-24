// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
const ref = 'p1:TEST-process:' + 'a'.repeat(64);
const request = {
  handle: { handleId: 'TEST-original' },
  commandId: 'TEST-stop',
  operation: 'process.terminate' as const,
  payload: { processRef: ref },
};
describe('finite owner process conversation', () => {
  it('rejects PID/audit/path/generation selection before any transport dispatch', async () => {
    const wire = vi.fn();
    const facade = new BackendOperationsFacade({ request: wire, lookup: vi.fn() });
    for (const payload of [
      { pid: 1001 },
      { processRef: ref, auditToken: [1] },
      { processRef: ref, path: '/TEST-no-selector' },
      { processRef: ref, generation: '2' },
    ]) {
      expect((await facade.invoke({ ...request, payload })).ok).toBe(false);
    }
    expect(wire).not.toHaveBeenCalled();
    expect(parseBackendOperation(request)).toEqual(request);
  });
  it('keeps accepted signal unresolved, binds original lookup identity and strips all private native fields', () => {
    const row = {
      id: 'TEST-process',
      pid: 1001,
      label: 'TEST service',
      registeredAt: '2026-10-23',
      processRef: ref,
      observation: 'same-live',
      canTerminate: true,
      capturedNative: { auditToken: [1] },
      privatePath: '/TEST-private',
    };
    const list = projectBackendResult(
      { ...request, operation: 'process.list', payload: {} },
      { ok: true, value: [row] }
    );
    expect(JSON.stringify(list)).not.toContain('auditToken');
    expect(JSON.stringify(list)).not.toContain('TEST-private');
    const original = {
      commandId: request.commandId,
      operation: 'terminate',
      originalProcessRef: ref,
      phase: 'held',
      state: { phase: 'requested', native: 'accepted' },
    };
    expect(projectBackendResult(request, { ok: true, value: original })).toMatchObject({
      ok: true,
      value: { phase: 'held', state: { phase: 'requested', native: 'accepted' } },
    });
    expect(() =>
      projectBackendResult(
        { ...request, operation: 'process.lookup', payload: { originalCommandId: 'TEST-other' } },
        { ok: true, value: original }
      )
    ).toThrow();
    expect(() =>
      projectBackendResult(
        { ...request, operation: 'process.list', payload: {} },
        { ok: true, value: [{ ...row, observation: 'unknown' }] }
      )
    ).toThrow();
  });
});
