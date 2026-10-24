// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { registerBackendConnectionsIpc } from '../../../src/features/agent-backend/main/adapters/input/registerBackendConnections';
import { CapturedTeamRegistry } from '../../../src/features/agent-backend/main/infrastructure/CapturedTeamRegistry';
import type { DesktopBackendFeature } from '../../../src/features/agent-backend/main/composition/DesktopBackendFeature';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
const held = { state: 'hold', bindings: [] };
const ready = { state: 'ready' as const, bindings: [] };
afterEach(() => vi.restoreAllMocks());
function setup(options: { context?: () => string | null; guard?: () => boolean; initialize?: () => Promise<void>; discover?: () => Promise<typeof ready> } = {}) {
  const initialize = vi.fn(options.initialize ?? (async () => {}));
  const discoverBindings = vi.fn(options.discover ?? (async () => ready));
  let handler: ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined;
  registerBackendConnectionsIpc({ handle: (_channel: string, selected: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handler = selected; }, removeHandler: () => {} } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>,
    { initialize, discoverBindings } as unknown as DesktopBackendFeature, options.context ?? (() => 'TEST-context'),
    options.guard ? () => ({ isCurrent: options.guard! }) : undefined);
  return { initialize, discoverBindings, invoke: (...args: unknown[]) => handler!({} as IpcMainInvokeEvent, ...args) };
}
it('revoked original guard cannot initialize or discover', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const value = setup({ guard: () => false }); expect(await value.invoke()).toEqual(held);
  expect(value.initialize).not.toHaveBeenCalled(); expect(value.discoverBindings).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith('[Feature:AgentBackendConnections]', 'Captured backend discovery held', { phase: 'guard-before-initialize', code: 'forbidden' });
});
it('context changes during initialization remain denied', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let context = 'TEST-A'; const value = setup({ context: () => context, initialize: async () => { context = 'TEST-B'; } });
  expect(await value.invoke()).toEqual(held); expect(value.discoverBindings).not.toHaveBeenCalled();
});
it('guard revocation after initialization cannot discover', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let current = true; const value = setup({ guard: () => current, initialize: async () => { current = false; } });
  expect(await value.invoke()).toEqual(held); expect(value.discoverBindings).not.toHaveBeenCalled();
});
it('reports finite lazy-host error code without private message or fields', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = Object.assign(new Error('/TEST/PRIVATE bearer TEST-secret'), { code: 'invalid-profile', privatePath: '/TEST/private' });
  const value = setup({ discover: async () => { throw error; } }); expect(await value.invoke()).toEqual(held);
  expect(warning).toHaveBeenCalledWith('[Feature:AgentBackendConnections]', 'Captured backend discovery held', { phase: 'discover-bindings', code: 'invalid-profile' });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('TEST-secret'); expect(JSON.stringify(warning.mock.calls)).not.toContain('/TEST/private');
});
it('unexpected raw codes cannot enter diagnostic frames and repeat frames are deduplicated', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const value = setup({ discover: async () => { throw Object.assign(new Error('TEST-private'), { code: 'TEST-private-code' }); } });
  for (let count = 0; count < 5; count++) expect(await value.invoke()).toEqual(held);
  expect(warning).toHaveBeenCalledTimes(1); expect(warning.mock.calls[0]?.[2]).toEqual({ phase: 'discover-bindings', code: 'unexpected' });
});
it('diagnostic sink failure cannot change HOLD or the original guard', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('TEST sink failure'); });
  const value = setup({ context: () => null }); expect(await value.invoke()).toEqual(held); expect(value.initialize).not.toHaveBeenCalled();
});
it('renderer argument claims cannot initialize or discover and valid snapshots remain identical', async () => {
  const value = setup(); expect(await value.invoke({ contextId: 'TEST-foreign' })).toEqual(held); expect(value.initialize).not.toHaveBeenCalled();
  expect(await value.invoke()).toBe(ready); expect(value.discoverBindings).toHaveBeenCalledOnce();
});
it('current registry list reaches startup and exact metadata request without a native provider', async () => {
  const start = vi.fn(async () => {}), request = vi.fn(async () => ({ ok: true, value: { teams: [], held: [] } }));
  const owner = { ownerId: 'TEST', revision: '1', protocolVersion: 1 as const, profileId: 'TEST', buildId: 'TEST', nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64), storageRoot: '/TEST' };
  const registry = new CapturedTeamRegistry({ owner, client: { request }, start, available: () => true });
  expect(await registry.list('TEST-context', { isCurrent: () => true })).toEqual({ teams: [], held: [] });
  expect(start).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledWith('team.registry.list', { owner, commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { contextId: 'TEST-context' } }, { control: true });
});
