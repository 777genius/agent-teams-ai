// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  STOPPED_TEAM_IMPORT_CHANNEL,
  STOPPED_TEAM_IMPORT_ROUTE,
} from '../../../src/features/agent-backend/contracts/stoppedImport';
import { importStoppedLegacyTeam } from '../../../src/features/agent-backend/main/application/importStoppedLegacyTeam';
import { createAgentBackendBridge } from '../../../src/features/agent-backend/preload/createAgentBackendBridge';
import { createAgentBackendHttpClient } from '../../../src/features/agent-backend/renderer/adapters/http/createAgentBackendHttpClient';

import type {
  DesktopBackendFeature,
  LegacyStoppedSourceOwners,
} from '../../../src/features/agent-backend/main';
const prepared = vi.hoisted(() => vi.fn());
vi.mock(
  '../../../src/features/agent-backend/main/infrastructure/stopped-import/prepareStoppedLegacyImport',
  () => ({ prepareStoppedLegacyImport: prepared })
);
const receipt = {
  commandId: 'TEST-original',
  phase: 'published' as 'published' | 'held',
  source: { sourceId: 'TEST-source', snapshotDigest: 'a'.repeat(64) },
  record: {
    contextId: 'TEST-context',
    teamName: 'TEST-team',
    binding: { handleId: 'TEST-handle' },
  },
};
function fixture() {
  prepared.mockReset();
  prepared.mockResolvedValue({
    contextId: 'TEST-context',
    sourceId: 'TEST-source',
    snapshotDigest: 'a'.repeat(64),
    teamName: 'TEST-team',
  });
  const client = {
    list: vi.fn(async () => [] as (typeof receipt)[]),
    lookup: vi.fn(async () => null as typeof receipt | null),
    publish: vi.fn<
      (commandId: string, request: unknown, guard: unknown) => Promise<typeof receipt>
    >(async () => receipt),
    retry: vi.fn(async () => receipt),
  };
  const registerPublished = vi.fn(async () => {});
  const captureStoppedImport = vi.fn(async () => ({ client, authority: {}, registerPublished }));
  const source = {
    sourceOwnerId: 'TEST-legacy',
    sourceId: 'TEST-source',
    contextId: 'TEST-context',
    teamName: 'TEST-team',
    roots: [],
    isCurrent: () => true,
  };
  const captureSource = vi.fn(() => source);
  const options = {
    feature: { captureStoppedImport } as unknown as DesktopBackendFeature,
    contextId: 'TEST-context',
    guard: { isCurrent: () => true },
    owners: {} as LegacyStoppedSourceOwners,
    captureSource,
    request: { teamName: 'TEST-team', action: 'prepare' },
  };
  return { options, client, registerPublished, captureStoppedImport, captureSource, source };
}
describe('existing stopped action detached Host handoff', () => {
  it('rejects all private selectors before source access; configuration remains unchanged', async () => {
    const f = fixture();
    expect(
      await importStoppedLegacyTeam({
        ...f.options,
        request: { ...f.options.request, path: '/TEST/forbidden' },
      })
    ).toMatchObject({ ok: false, reason: 'invalid', outcome: 'not-dispatched' });
    expect(f.captureSource).not.toHaveBeenCalled();
    expect(f.captureStoppedImport).not.toHaveBeenCalled();
  });
  it('published original survives missing source and registers only the canonical saved configuration', async () => {
    const f = fixture();
    f.captureSource.mockImplementation(() => {
      throw Object.assign(new Error('TEST-gone'), { code: 'ENOENT' });
    });
    f.client.list.mockResolvedValue([receipt]);
    expect(await importStoppedLegacyTeam(f.options)).toEqual({
      ok: true,
      selection: 'host-team:TEST-handle',
    });
    expect(prepared).not.toHaveBeenCalled();
    expect(f.client.publish).not.toHaveBeenCalled();
    expect(f.registerPublished).toHaveBeenCalledWith(receipt.record);
  });
  it('source replacement and held originals refuse prepare; retry uses the immutable original map', async () => {
    const f = fixture();
    f.client.list.mockResolvedValue([{ ...receipt, phase: 'held' }]);
    expect(await importStoppedLegacyTeam(f.options)).toMatchObject({ ok: false, reason: 'held' });
    expect(prepared).not.toHaveBeenCalled();
    expect(
      await importStoppedLegacyTeam({
        ...f.options,
        request: { teamName: 'TEST-team', action: 'retry' },
      })
    ).toMatchObject({ ok: true });
    expect(f.client.retry).toHaveBeenCalledWith(
      'TEST-original',
      { contextId: 'TEST-context', teamName: 'TEST-team', ...receipt.source },
      f.options.guard
    );
    f.source.sourceId = 'TEST-replacement';
    expect(await importStoppedLegacyTeam(f.options)).toMatchObject({ ok: false, reason: 'held' });
  });
  it('uncertain publication queries the original command and retains UNKNOWN on absence without retry', async () => {
    const f = fixture();
    f.client.publish.mockRejectedValue(new Error('TEST-lost-ACK'));
    expect(await importStoppedLegacyTeam(f.options)).toMatchObject({
      ok: false,
      reason: 'unknown',
      outcome: 'unknown',
    });
    const commandId = f.client.publish.mock.calls[0]![0];
    expect(f.client.lookup).toHaveBeenLastCalledWith(commandId, 'TEST-context', f.options.guard);
    expect(f.client.retry).not.toHaveBeenCalled();
    expect(f.registerPublished).not.toHaveBeenCalled();
    await importStoppedLegacyTeam({
      ...f.options,
      request: { teamName: 'TEST-team', action: 'lookup' },
    });
    expect(f.client.publish).toHaveBeenCalledTimes(1);
  });
  it('IPC and HTTP bridges carry the same finite action and never retry', async () => {
    const request = { teamName: 'TEST-team', action: 'lookup' as const },
      result = { ok: false as const, reason: 'unknown' as const, outcome: 'unknown' as const };
    const invoke = vi.fn(async () => result),
      post = vi.fn(async () => result);
    const ipc = createAgentBackendBridge({ invoke: vi.fn() } as never, undefined, { invoke });
    const http = createAgentBackendHttpClient(vi.fn(), vi.fn(), undefined, post);
    expect(await ipc.stoppedImport!(request)).toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(STOPPED_TEAM_IMPORT_CHANNEL, request);
    expect(await http.stoppedImport!(request)).toEqual(result);
    expect(post).toHaveBeenCalledExactlyOnceWith(STOPPED_TEAM_IMPORT_ROUTE, request);
  });
});
