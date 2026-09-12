import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureCursorAgentAtomicReapBridge,
  createCursorAgentAtomicReapPort,
  type CursorAgentAtomicReapInput,
  DEFAULT_CURSOR_AGENT_ATOMIC_REAP_PORT,
} from './CursorAgentAtomicReapBridge';

import type { OpenCodeReadinessBridgeCommandExecutor } from './OpenCodeReadinessBridge';

const request: CursorAgentAtomicReapInput = {
  contractVersion: 1,
  reason: 'team-stop',
  ownedWorkspaceCwds: ['/fixture/workspace'],
  startedBeforeMs: 1700000000000,
};
const completed = { contractVersion: 1, status: 'completed', killedPids: [8100], diagnostics: [] };

function fixture(reply: unknown) {
  const execute = vi.fn(async () => reply);
  const executor = { execute } as unknown as OpenCodeReadinessBridgeCommandExecutor;
  return { execute, executor, port: createCursorAgentAtomicReapPort(executor) };
}

afterEach(() => configureCursorAgentAtomicReapBridge(null));

describe('CursorAgentAtomicReapBridge', () => {
  it('dispatches once with only the versioned body and a 15 second executor timeout', async () => {
    const { execute, port } = fixture({ ok: true, data: completed });
    const canDispatch = () => true;
    const input = {
      ...request,
      canDispatch,
      callerPid: 123,
      owners: ['stale'],
      lockPath: '/forbidden',
    };
    expect(await port.reapUnleasedCursorAgentTrees(input)).toEqual(completed);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      'opencode.reapUnleasedCursorAgentTrees',
      request,
      { cwd: '/fixture/workspace', timeoutMs: 15000, canDispatch }
    );
  });

  it.each(['completed', 'kept', 'incomplete'] as const)(
    'preserves validated %s replies exactly',
    async (status) => {
      const data = {
        ...completed,
        status,
        diagnostics: ['Kept pid=8200: active lease', 'partial result'],
      };
      const { port } = fixture({ ok: true, data });
      expect(await port.reapUnleasedCursorAgentTrees(request)).toEqual(data);
    }
  );

  it.each([
    null,
    {},
    { ...completed, contractVersion: 2 },
    { ...completed, status: 'unsupported' },
    { ...completed, status: 'unknown' },
    { ...completed, status: 'success' },
    { ...completed, killedPids: [0] },
    { ...completed, killedPids: [-1] },
    { ...completed, killedPids: [1.5] },
    { ...completed, killedPids: ['8100'] },
    { ...completed, killedPids: [Number.MAX_SAFE_INTEGER + 1] },
    { ...completed, killedPids: [NaN] },
    { ...completed, killedPids: [8100, 8100] },
    { ...completed, diagnostics: 'bad' },
    { ...completed, diagnostics: [42] },
  ])('rejects malformed runtime data without trusting killed PIDs: %j', async (data) => {
    const { port, execute } = fixture({ ok: true, data });
    const result = await port.reapUnleasedCursorAgentTrees(request);
    expect(result.status).toBe('unknown');
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    null,
    { ok: false, error: { kind: 'unsupported_command' } },
    { ok: false, error: { kind: 'timeout' } },
    { ok: false, data: completed },
    { ok: 'true', data: completed },
  ])('fails closed on failed or invalid envelopes without retry: %j', async (reply) => {
    const { port, execute } = fixture(reply);
    const result = await port.reapUnleasedCursorAgentTrees(request);
    expect(result.status).toBe('unknown');
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('contains executor failures and never retries', async () => {
    const { port, execute } = fixture(undefined);
    execute.mockRejectedValueOnce(new Error('transport failed'));
    const result = await port.reapUnleasedCursorAgentTrees(request);
    expect(result.status).toBe('unknown');
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics[0]).toContain('transport failed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not dispatch when admission is revoked', async () => {
    const { port, execute } = fixture({ ok: true, data: completed });
    expect(
      await port.reapUnleasedCursorAgentTrees({ ...request, canDispatch: () => false })
    ).toMatchObject({ status: 'kept', killedPids: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...request, ownedWorkspaceCwds: [] },
    { ...request, ownedWorkspaceCwds: [''] },
    { ...request, startedBeforeMs: NaN },
    { ...request, startedBeforeMs: Infinity },
    { ...request, startedBeforeMs: -1 },
  ])('does not dispatch an invalid scope or fence', async (input) => {
    const { port, execute } = fixture({ ok: true, data: completed });
    expect(await port.reapUnleasedCursorAgentTrees(input)).toMatchObject({
      status: 'unknown',
      killedPids: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the default proxy inert until configured and after reset', async () => {
    configureCursorAgentAtomicReapBridge(null);
    const { executor, execute } = fixture({ ok: true, data: completed });
    const proxy = DEFAULT_CURSOR_AGENT_ATOMIC_REAP_PORT;
    expect(await proxy.reapUnleasedCursorAgentTrees(request)).toMatchObject({
      status: 'unsupported',
      killedPids: [],
    });
    expect(execute).not.toHaveBeenCalled();
    configureCursorAgentAtomicReapBridge(executor);
    expect(await proxy.reapUnleasedCursorAgentTrees(request)).toEqual(completed);
    configureCursorAgentAtomicReapBridge(null);
    expect(await proxy.reapUnleasedCursorAgentTrees(request)).toMatchObject({
      status: 'unsupported',
      killedPids: [],
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
