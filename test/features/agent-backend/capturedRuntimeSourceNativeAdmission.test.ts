// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { captureRuntimeSources } from '../../../src/features/agent-backend/main/infrastructure/CapturedRuntimeSources';

import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { RuntimeSourceGrant, RuntimeSourcePublishIntent } from '@agent-teams/legacy-agent-host/runtime-sources';

const grant: RuntimeSourceGrant = { targetId: 'a'.repeat(64), ownerId: 'TEST-owner', ownerRevision: 'TEST-owner-v1',
  contextId: 'TEST-context', projectPath: null, runtimeId: 'codex', profileId: 'TEST-profile', configRevision: 'TEST-config', teamScopes: [] };
const candidate = { sourceKind: 'app-managed' as const, executable: { path: process.execPath, sha256: 'b'.repeat(64) } };
const input: RuntimeSourcePublishIntent = { commandId: 'TEST-command', expectedRevision: 'c'.repeat(64), candidate };

it('private native admission spans only the original dispatch and is removed on every terminal outcome', async () => {
  for (const outcome of ['ok', 'refused', 'transport', 'stale'] as const) {
    const events: string[] = [];
    let current = true, active = false;
    const request = vi.fn(async (method: string, params?: JsonValue): Promise<JsonValue> => {
      expect(method).toBe('runtime.source.publish'); expect(active).toBe(true);
      expect(params).toEqual({ ...input, grant }); events.push('dispatch');
      if (outcome === 'transport') throw new Error('TEST transport ended');
      if (outcome === 'stale') current = false;
      return outcome === 'refused' ? { ok: false, code: 'held' } :
        { ok: true, value: { commandId: input.commandId, phase: 'prepared' } };
    });
    const sources = captureRuntimeSources({ grant, client: { request },
      start: async () => { events.push('start'); }, ownerAvailable: () => true, foregroundCurrent: () => current,
      prepareNativePublication: selected => {
        expect(selected).toEqual(input); expect(current).toBe(true); expect(active).toBe(false);
        active = true; events.push('admit'); return () => { active = false; events.push('revoke'); };
      } });
    if (outcome === 'ok') await expect(sources.publish(input)).resolves.toEqual({ commandId: input.commandId, phase: 'prepared' });
    else await expect(sources.publish(input)).rejects.toThrow();
    expect(active).toBe(false); expect(events).toEqual(['start', 'admit', 'dispatch', 'revoke']);
  }
});

it('guard loss during original owner startup never creates a pending native grant', async () => {
  let current = true;
  const prepare = vi.fn(() => () => {}), request = vi.fn(async () => ({ ok: true, value: null }));
  const sources = captureRuntimeSources({ grant, client: { request },
    start: async () => { current = false; }, ownerAvailable: () => true, foregroundCurrent: () => current,
    prepareNativePublication: prepare });
  await expect(sources.publish(input)).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});

it('cold read, retained discovery and lookup have no probe admission; explicit recover and refresh keep separate grants', async () => {
  const events: string[] = [];
  const summary = { sourceId: grant.targetId, revision: 'd'.repeat(64), sourceKind: 'captured',
    profileId: grant.profileId, configRevision: grant.configRevision };
  const request = vi.fn(async (method: string) => ({ ok: true, value:
    method === 'runtime.source.current' ? summary : method === 'runtime.source.retained' ? [summary] :
      method === 'runtime.source.refreshConfiguration' ? { commandId: input.commandId, phase: 'prepared' } : null }));
  const sources = captureRuntimeSources({ grant, client: { request }, start: async () => {},
    ownerAvailable: () => true, foregroundCurrent: () => true,
    prepareNativePublication: () => { events.push('publish'); return () => events.push('publish-close'); },
    prepareNativeRecovery: () => { events.push('recover'); return () => events.push('recover-close'); },
    prepareNativeConfiguration: selected => {
      expect(selected).toEqual({ commandId: input.commandId, expectedRevision: input.expectedRevision });
      events.push('refresh'); return () => events.push('refresh-close');
    } });
  await sources.current(); await sources.retained(); await sources.lookup(input.commandId);
  expect(events).toEqual([]);
  await sources.recover(); await sources.refreshConfiguration({ commandId: input.commandId, expectedRevision: input.expectedRevision });
  expect(events).toEqual(['recover', 'recover-close', 'refresh', 'refresh-close']);
});
