// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { CapturedModelProbe } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedModelProbe';

import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

const input = {
  runtimeId: 'opencode' as const,
  providerId: 'TEST-provider',
  modelId: 'TEST-provider/TEST-model',
  requestGroupId: 'TEST-group',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let current = true,
    block = false,
    finish = false;
  const closing = deferred<void>();
  const calls: { operation: string; commandId: string }[] = [];
  const phases = new Map<string, string>();
  const selections = new Map<string, { providerId: string; modelId: string }>();
  const target: CapturedProviderManagement = {
    targetId: 'a'.repeat(64),
    profileId: 'TEST-original',
    configRevision: 'TEST-config',
    isCurrent: () => current,
    async request(operation, payload): Promise<JsonValue> {
      const commandId = String(payload.commandId);
      calls.push({ operation, commandId });
      if (operation === 'probe.start') {
        selections.set(commandId, {
          providerId: String(payload.providerId),
          modelId: String(payload.modelId),
        });
        phases.set(commandId, finish ? 'completed' : 'running');
      }
      if (operation === 'probe.cancel') {
        if (block) await closing.promise;
        phases.set(commandId, 'cancelled');
      }
      if (operation === 'probe.read' && finish && phases.get(commandId) === 'running')
        phases.set(commandId, 'completed');
      return {
        ok: true,
        value: {
          commandId,
          profileId: target.profileId,
          configRevision: target.configRevision,
          providerId: selections.get(commandId)?.providerId ?? input.providerId,
          modelId: selections.get(commandId)?.modelId ?? input.modelId,
          phase: phases.get(commandId)!,
          ok: phases.get(commandId) === 'completed',
          expiresAt: Date.now() + 10000,
          privateExtra: 'TEST-private-native-model-text',
        },
      };
    },
  };
  const capture = vi.fn(async (_path: string | null) => target);
  return {
    target,
    capture,
    calls,
    probes: new CapturedModelProbe(capture),
    closing,
    stale: () => {
      current = false;
    },
    blockClose: () => {
      block = true;
    },
    finish: () => {
      finish = true;
    },
  };
}

it('only a completed native probe becomes model availability; private metadata is not projected', async () => {
  const f = fixture();
  f.finish();
  const result = await f.probes.test(input);
  expect(result.result).toMatchObject({
    ok: true,
    availability: 'available',
    providerId: input.providerId,
    modelId: input.modelId,
  });
  expect(JSON.stringify(result)).not.toContain('TEST-private');
  expect(f.calls.map((call) => call.operation)).toEqual(['probe.start']);
});

it('cancel during capture prevents even lazy native admission', async () => {
  const f = fixture(),
    opening = deferred<CapturedProviderManagement>();
  f.capture.mockReturnValue(opening.promise);
  const pending = f.probes.test(input);
  expect(await f.probes.cancel({ requestGroupId: input.requestGroupId })).toEqual({ ok: true });
  opening.resolve(f.target);
  expect((await pending).error).toBeDefined();
  expect(f.calls).toEqual([]);
});

it('replacement of one UI group waits for original physical cancel and does not erase the new group', async () => {
  const f = fixture();
  f.blockClose();
  const old = f.probes.test(input);
  await vi.waitFor(() =>
    expect(f.calls.some((call) => call.operation === 'probe.start')).toBe(true)
  );
  const next = f.probes.test(input);
  await vi.waitFor(() =>
    expect(f.calls.some((call) => call.operation === 'probe.cancel')).toBe(true)
  );
  expect(f.calls.filter((call) => call.operation === 'probe.start')).toHaveLength(1);
  f.finish();
  f.closing.resolve();
  expect((await old).error).toBeDefined();
  expect((await next).result?.ok).toBe(true);
  const starts = f.calls.filter((call) => call.operation === 'probe.start');
  expect(starts).toHaveLength(2);
  expect(starts[0]?.commandId).not.toBe(starts[1]?.commandId);
});

it('foreground change cancels the original capture and never projects a late native success', async () => {
  const f = fixture();
  const pending = f.probes.test(input);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  f.stale();
  f.finish();
  expect((await pending).error).toBeDefined();
  expect(f.calls.filter((call) => call.operation === 'probe.start')).toHaveLength(1);
  expect(f.capture).toHaveBeenCalledTimes(1);
});

it.each(['opencode', 'claude'] as const)(
  'cancel while %s Host startup is pending prevents native probe admission after startup completes',
  async (runtimeId) => {
    const { captureProviderManagement } =
      await import('../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement');
    const startup = deferred<void>();
    const wire = vi.fn(async () => ({ ok: true, value: null }));
    const start = vi.fn(() => startup.promise);
    const capture = async (_path: string | null, current?: () => boolean) =>
      captureProviderManagement({
        targetId: 'a'.repeat(64),
        profileId: 'TEST-original',
        configRevision: 'TEST-config',
        client: { request: wire },
        start,
        ownerAvailable: () => true,
        foregroundCurrent: () => current?.() ?? true,
      });
    const probes =
      runtimeId === 'claude'
        ? new CapturedModelProbe(
            async () => {
              throw new Error('Wrong runtime');
            },
            undefined,
            capture
          )
        : new CapturedModelProbe(capture);
    const pending = probes.test({
      ...input,
      runtimeId,
      providerId: runtimeId === 'claude' ? 'anthropic' : input.providerId,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const cancel = probes.cancel({ requestGroupId: input.requestGroupId });
    startup.resolve();
    expect(await cancel).toEqual({ ok: true });
    expect((await pending).error).toBeDefined();
    expect(wire).not.toHaveBeenCalled();
  }
);

it('Claude model tests capture their native runtime and do not apply OpenCode model-limit preferences', async () => {
  const f = fixture();
  f.finish();
  const wrong = vi.fn(async () => {
    throw new Error('Wrong runtime');
  });
  const limits = vi.fn(async () => ({ contextTokens: 4096, outputTokens: 128 }));
  const probes = new CapturedModelProbe(wrong, limits, f.capture);
  const result = await probes.test({
    ...input,
    runtimeId: 'claude',
    providerId: 'anthropic',
    modelId: 'claude-opus-4-6',
  });
  expect(result).toMatchObject({
    runtimeId: 'claude',
    result: {
      ok: true,
      providerId: 'anthropic',
      modelId: 'claude-opus-4-6',
      availability: 'available',
    },
  });
  expect(wrong).not.toHaveBeenCalled();
  expect(limits).not.toHaveBeenCalled();
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.calls.filter((call) => call.operation === 'probe.start')).toHaveLength(1);
});

it('an unavailable Claude capture refuses before any default runtime or probe start', async () => {
  const f = fixture();
  const result = await f.probes.test({ ...input, runtimeId: 'claude', providerId: 'anthropic' });
  expect(result).toMatchObject({ runtimeId: 'claude', error: { code: 'model-test-failed' } });
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});
