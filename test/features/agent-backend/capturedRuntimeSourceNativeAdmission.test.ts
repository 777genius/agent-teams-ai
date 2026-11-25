// @vitest-environment node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

import { captureRuntimeSources } from '../../../src/features/agent-backend/main/infrastructure/CapturedRuntimeSources';
import { observeEmulatedSourcePeerReadiness } from '../../../tools/owned-process-broker/nativeEmulatedSourceReadiness';

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

it('retains bounded existing Codex peer stages without private values or fabricated readiness', () => {
  const privateValue = 'TEST-private-peer-value';
  const event = (event: string, fields: Record<string, unknown> = {}) =>
    ({ provider: 'codex', role: 'runtime', pid: 42, event, privateValue, ...fields });
  const values = [
    event('launch', { parentPid: 40, argc: 5 }),
    event('mcp-catalog', { configuredServers: 0 }),
    event('managed-configuration-read', { selectedServers: ['team'] }),
    event('managed-configuration-read', { selectedServers: ['team'] }),
    event('connected', { tools: [privateValue, 'task_list'] }),
    event('exit', { code: 0 }),
    event('input', { marker: privateValue }),
    { ...event('connected', { tools: [privateValue] }), provider: 'opencode' },
  ];
  const evidence: Record<string, unknown> = {};
  observeEmulatedSourcePeerReadiness(evidence, values, 'codex');
  expect(evidence.sourcePeerReadiness).toEqual({
    status: 'observed', provider: 'codex', capturePoint: 'existing-post-cleanup-effects-read',
    atomicWithReadinessFailure: false, truncated: false,
    events: [
      { ordinal: 1, event: 'launch', pid: 42, role: 'runtime', parentPid: 40, argc: 5 },
      { ordinal: 2, event: 'mcp-catalog', pid: 42, role: 'runtime', configuredServers: 0 },
      { ordinal: 3, event: 'managed-configuration-read', pid: 42, role: 'runtime', selectedServerCount: 1, teamSelected: true },
      { ordinal: 4, event: 'managed-configuration-read', pid: 42, role: 'runtime', selectedServerCount: 1, teamSelected: true },
      { ordinal: 5, event: 'connected', pid: 42, role: 'runtime', toolCount: 2 },
      { ordinal: 6, event: 'exit', pid: 42, role: 'runtime', code: 0 },
    ],
  });
  expect(JSON.stringify(evidence)).not.toContain(privateValue);
  expect(values[2]).toEqual(values[3]);
  const bounded: Record<string, unknown> = {};
  observeEmulatedSourcePeerReadiness(bounded,
    Array.from({ length: 65 }, () => event('mcp-catalog', { configuredServers: 0 })), 'codex');
  const retained = bounded.sourcePeerReadiness as { events: unknown[]; truncated: boolean };
  expect(retained.events).toHaveLength(64); expect(retained.truncated).toBe(true);
  const absent: Record<string, unknown> = {};
  observeEmulatedSourcePeerReadiness(absent, values, 'claude'); expect(absent).toEqual({});
  for (const invalid of [
    event('launch', { parentPid: 40, argc: 1025 }),
    event('mcp-catalog', { configuredServers: -1 }),
    event('managed-configuration-read', { selectedServers: [privateValue] }),
    event('connected', { tools: [null] }),
    event('exit', { code: 7 }),
    Object.defineProperty(event('launch', { parentPid: 40, argc: 5 }), 'pid', {
      get() { throw new Error(privateValue); },
    }),
  ]) {
    const unknown: Record<string, unknown> = {};
    expect(() => observeEmulatedSourcePeerReadiness(unknown, [invalid], 'codex')).not.toThrow();
    expect(unknown).toEqual({ sourcePeerReadiness: { status: 'unknown', provider: 'codex' } });
  }
});

it('the actual existing effects/pins callsite keeps one read and original failure identity', () => {
  const source = readFileSync(new URL('../../../tools/owned-process-broker/nativeEmulatedSourceScenario.ts', import.meta.url), 'utf8');
  const lines = source.split('\n'), marker =
    '    try { observeEmulatedSourcePeerReadiness(evidence, effects(), provider);';
  const indexes = lines.flatMap((line, index) => line.startsWith(marker) ? [index] : []);
  expect(indexes).toHaveLength(1);
  const originalTail = new Function('observeEmulatedSourcePeerReadiness', 'evidence', 'effects',
    'provider', 'fixture', 'fileHash', 'assert', 'errors',
    lines.slice(indexes[0]!, indexes[0]! + 2).join('\n')) as (...args: unknown[]) => void;
  for (const outcome of ['complete', 'effects-refusal', 'observer-and-pin-refusal'] as const) {
    const error = new Error('TEST-original-' + outcome), calls: string[] = [], errors: unknown[] = [];
    const evidence: Record<string, unknown> = {};
    if (outcome === 'observer-and-pin-refusal') Object.defineProperty(evidence, 'sourcePeerReadiness', {
      set() { throw new Error('TEST-passive-observer-refusal'); },
    });
    originalTail((...args: Parameters<typeof observeEmulatedSourcePeerReadiness>) => {
      calls.push('observe'); observeEmulatedSourcePeerReadiness(...args);
    }, evidence, () => {
      calls.push('effects'); if (outcome === 'effects-refusal') throw error; return [];
    }, 'codex', { pins: [{ path: 'TEST-original-pin', sha256: 'TEST-original-sha' }] }, (path: string) => {
      calls.push('pin'); expect(path).toBe('TEST-original-pin');
      if (outcome === 'observer-and-pin-refusal') throw error;
      return 'TEST-original-sha';
    }, assert, errors);
    expect(calls).toEqual(outcome === 'effects-refusal' ? ['effects'] : ['effects', 'observe', 'pin']);
    if (outcome === 'complete') expect(errors).toEqual([]);
    else { expect(errors).toHaveLength(1); expect(errors[0]).toBe(error); }
  }
});
