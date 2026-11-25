import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeRetainedLegacyLaunch,
  createRetainedLegacyLaunchClient,
  openRetainedLegacyLaunch,
} from '../../../src/features/agent-backend/renderer/retainedLegacyLaunch';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type {
  RetainedLegacyLaunchChoice,
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchResult,
} from '../../../src/features/agent-backend/contracts/retainedLegacyLaunch';
import type { CliInstallationStatus } from '../../../src/shared/types';

const ambient = vi.hoisted(() => ({ agentBackend: undefined as unknown }));
vi.mock('@renderer/api', () => ({ api: ambient }));
type Transport = (request: RetainedLegacyLaunchRequest) => Promise<RetainedLegacyLaunchResult>;
let sequence = 0;
function choice(): RetainedLegacyLaunchChoice {
  const id = ++sequence;
  return { mode: 'original-runtime', teamName: `TEST-team-${id}`, scopeId: `TEST-scope-${id}`,
    projectPath: '/TEST/original-project', expiresAt: Date.now() + 600_000 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const unknown = { ok: false, reason: 'outcome-unknown', outcome: 'unknown' } as const;
function cleanup(request: RetainedLegacyLaunchRequest): RetainedLegacyLaunchResult {
  if (request.action === 'close' || request.action === 'closeIntent')
    return { ok: true, action: request.action, value: null };
  throw new Error('Unexpected TEST action ' + request.action);
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(async () => {
  invalidateContextScopedRequestEpoch();
  await flush();
  ambient.agentBackend = undefined;
});

describe('original runtime choice opening and captured cleanup', () => {
  it('recovers a lost open response with the same intent and original transport', async () => {
    const original = choice();
    let opens = 0;
    const send = vi.fn<Transport>(async request => {
      if (request.action === 'open') {
        if (++opens === 1) throw new Error('TEST-open-ACK-lost');
        return { ok: true, action: 'open', value: original };
      }
      return cleanup(request);
    });
    ambient.agentBackend = { retainedLegacyLaunch: send };
    await expect(openRetainedLegacyLaunch(original.teamName)).rejects.toMatchObject({ outcome: 'unknown' });
    const replacement = vi.fn<Transport>(async () => unknown);
    ambient.agentBackend = { retainedLegacyLaunch: replacement };
    expect(await openRetainedLegacyLaunch(original.teamName)).toEqual(original);
    const requests = send.mock.calls.map(([request]) => request).filter(request => request.action === 'open');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await closeRetainedLegacyLaunch(original);
    expect(send).toHaveBeenLastCalledWith({ action: 'closeIntent', teamName: original.teamName,
      intentId: requests[0]!.intentId });
    expect(replacement).not.toHaveBeenCalled();
  });

  it('does not allocate twice while the same original open is pending', async () => {
    const original = choice(), response = deferred<RetainedLegacyLaunchResult>();
    const send = vi.fn<Transport>(request => request.action === 'open' ? response.promise : Promise.resolve(cleanup(request)));
    ambient.agentBackend = { retainedLegacyLaunch: send };
    const pending = openRetainedLegacyLaunch(original.teamName);
    await expect(openRetainedLegacyLaunch(original.teamName)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(send).toHaveBeenCalledTimes(1);
    response.resolve({ ok: true, action: 'open', value: original });
    expect(await pending).toEqual(original);
    await closeRetainedLegacyLaunch(original);
  });

  it.each(['abort', 'context'] as const)('closes the exact pending open intent after %s, including a late scope response', async reason => {
    const original = choice(), response = deferred<RetainedLegacyLaunchResult>(), abort = new AbortController();
    const send = vi.fn<Transport>(request => request.action === 'open' ? response.promise : Promise.resolve(cleanup(request)));
    ambient.agentBackend = { retainedLegacyLaunch: send };
    const pending = openRetainedLegacyLaunch(original.teamName, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ outcome: 'not-dispatched' });
    const opening = send.mock.calls[0]![0];
    expect(opening.action).toBe('open');
    if (opening.action !== 'open') throw new Error('Missing original open');
    if (reason === 'abort') abort.abort(); else invalidateContextScopedRequestEpoch();
    await flush();
    response.resolve({ ok: true, action: 'open', value: original });
    await rejected;
    const closes = send.mock.calls.map(([request]) => request).filter(request => request.action !== 'open');
    expect(closes.length).toBeGreaterThan(0);
    expect(closes.every(request => request.action === 'closeIntent' && request.teamName === original.teamName &&
      request.intentId === opening.intentId)).toBe(true);
    expect(send.mock.calls.filter(([request]) => request.action === 'open')).toHaveLength(1);
  });

  it('does not issue a fresh open while closure of the original choice remains unknown', async () => {
    const original = choice();
    let allowClose = false, opens = 0;
    const send = vi.fn<Transport>(async request => {
      if (request.action === 'open') {
        opens++;
        return { ok: true, action: 'open', value: { ...original, scopeId: `${original.scopeId}-${opens}` } };
      }
      return allowClose ? cleanup(request) : unknown;
    });
    ambient.agentBackend = { retainedLegacyLaunch: send };
    const selected = await openRetainedLegacyLaunch(original.teamName);
    await closeRetainedLegacyLaunch(selected);
    await expect(openRetainedLegacyLaunch(original.teamName)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(opens).toBe(1);
    const oldIntent = send.mock.calls[0]![0];
    allowClose = true;
    const next = await openRetainedLegacyLaunch(original.teamName);
    expect(opens).toBe(2);
    expect(send.mock.calls.filter(([request]) => request.action === 'open')[1]![0]).not.toEqual(oldIntent);
    await closeRetainedLegacyLaunch(next);
  });

  it('never resolves an ambient transport for an unowned or already closed choice', async () => {
    const original = choice(), ambientSend = vi.fn<Transport>(async () => unknown);
    ambient.agentBackend = { retainedLegacyLaunch: ambientSend };
    const client = createRetainedLegacyLaunchClient(original);
    await expect(client.read()).rejects.toMatchObject({ outcome: 'not-dispatched' });
    await client.close();
    expect(ambientSend).not.toHaveBeenCalled();
  });
});

describe('original runtime client operations', () => {
  it('shares an in-flight status read and keeps snapshots confined to their original client', async () => {
    const original = choice(), response = deferred<RetainedLegacyLaunchResult>();
    const status = { flavor: 'agent_teams_orchestrator', providers: [] } as unknown as CliInstallationStatus;
    const send = vi.fn<Transport>(request => request.action === 'status' ? response.promise : Promise.resolve(cleanup(request)));
    const client = createRetainedLegacyLaunchClient(original, send);
    const first = client.status(original.projectPath);
    expect(client.status(original.projectPath)).toBe(first);
    const a = client.resource('status', () => first);
    expect(client.resource('status', async () => { throw new Error('Wrong shared loader'); })).toBe(a);
    response.resolve({ ok: true, action: 'status', value: status });
    expect(await first).toBe(status);
    expect(send.mock.calls.filter(([request]) => request.action === 'status')).toHaveLength(1);
    expect(await a.ensure()).toBe(true);
    await client.close();
    expect(a.getSnapshot().value).toBeNull();
    await expect(client.status(original.projectPath)).rejects.toMatchObject({ outcome: 'not-dispatched' });
  });

  it.each(['roster', 'launch'] as const)('accepts the original successful %s ACK when only its dialog closed', async action => {
    const original = choice(), response = deferred<RetainedLegacyLaunchResult>();
    const send = vi.fn<Transport>(request => request.action === action ? response.promise : Promise.resolve(cleanup(request)));
    const client = createRetainedLegacyLaunchClient(original, send, () => true);
    const pending = action === 'roster' ? client.replaceMembers(original.teamName, { members: [] }) :
      client.launch({ teamName: original.teamName, cwd: original.projectPath });
    await client.close();
    response.resolve(action === 'roster' ? { ok: true, action, value: null } : { ok: true, action, value: { runId: 'TEST-run' } });
    await expect(pending).resolves.toEqual(action === 'roster' ? undefined : { runId: 'TEST-run' });
    expect(send.mock.calls.filter(([request]) => request.action === action)).toHaveLength(1);
  });

  it('keeps a late read UNKNOWN when its original context was revoked', async () => {
    const original = choice(), response = deferred<RetainedLegacyLaunchResult>();
    let current = true;
    const send = vi.fn<Transport>(request => request.action === 'read' ? response.promise : Promise.resolve(cleanup(request)));
    const client = createRetainedLegacyLaunchClient(original, send, () => current);
    const pending = client.read(), rejected = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    current = false;
    response.resolve(unknown);
    await rejected;
    await client.close();
    expect(send.mock.calls.filter(([request]) => request.action === 'read')).toHaveLength(1);
  });

  it('only permits cancellation of a model group this original client admitted, even after close', async () => {
    const original = choice(), loaded = deferred<RetainedLegacyLaunchResult>();
    let current = true;
    const send = vi.fn<Transport>(async request => {
      if (request.action === 'models') return loaded.promise;
      if (request.action === 'cancelModels') return { ok: true, action: 'cancelModels', value: { ok: true } };
      return cleanup(request);
    });
    const client = createRetainedLegacyLaunchClient(original, send, () => current);
    const pending = client.management.loadModels({ runtimeId: 'opencode', providerId: 'TEST-provider',
      projectPath: original.projectPath, requestGroupId: 'TEST-owned-group' });
    const rejected = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    current = false;
    await client.close();
    expect(await client.management.cancelModelLoad({ requestGroupId: 'TEST-owned-group' })).toEqual({ ok: true });
    await expect(client.management.cancelModelLoad({ requestGroupId: 'TEST-foreign-group' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
    await expect(client.management.loadModels({ runtimeId: 'opencode', providerId: 'TEST-provider', requestGroupId: 'TEST-late' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
    loaded.resolve(unknown);
    await rejected;
    expect(send.mock.calls.filter(([request]) => request.action === 'models')).toHaveLength(1);
    expect(send.mock.calls.filter(([request]) => request.action === 'cancelModels')).toEqual([[{
      action: 'cancelModels', scopeId: original.scopeId, input: { requestGroupId: 'TEST-owned-group' },
    }]]);
  });

  it('refuses another team and connection mutations before dispatch', async () => {
    const original = choice(), send = vi.fn<Transport>(async request => cleanup(request));
    const client = createRetainedLegacyLaunchClient(original, send);
    await expect(client.launch({ teamName: 'TEST-foreign', cwd: original.projectPath })).rejects.toMatchObject({ outcome: 'not-dispatched' });
    await expect(client.replaceMembers('TEST-foreign', { members: [] })).rejects.toMatchObject({ outcome: 'not-dispatched' });
    await expect(client.management.setDefaultModel({ runtimeId: 'opencode', providerId: 'TEST-provider', modelId: 'TEST-model' })).rejects.toThrow(/fixed for this launch/);
    expect(send).not.toHaveBeenCalled();
    await client.close();
  });

  it('coalesces a pending rebind and recovers UNKNOWN with its exact original project and intent', async () => {
    const original = choice(), first = deferred<RetainedLegacyLaunchResult>();
    const next = { ...original, scopeId: original.scopeId + '-next', projectPath: '/TEST/next-project' };
    let rebinds = 0;
    const send = vi.fn<Transport>(request => {
      if (request.action === 'rebind') return ++rebinds === 1 ? first.promise : Promise.resolve({ ok: true, action: 'rebind', value: next });
      return Promise.resolve(cleanup(request));
    });
    const client = createRetainedLegacyLaunchClient(original, send);
    const pending = client.rebind(next.projectPath, 'TEST-rebind');
    expect(client.rebind(next.projectPath, 'TEST-rebind')).toBe(pending);
    const rejected = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    first.reject(new Error('TEST-rebind-ACK-lost'));
    await rejected;
    await expect(client.rebind('/TEST/different', 'TEST-new-intent')).rejects.toMatchObject({ outcome: 'unknown' });
    expect(rebinds).toBe(1);
    expect(await client.rebind(next.projectPath, 'TEST-rebind')).toEqual(next);
    const requests = send.mock.calls.filter(([request]) => request.action === 'rebind');
    expect(requests[1]).toEqual(requests[0]);
    await client.close();
    expect(send).toHaveBeenLastCalledWith({ action: 'close', scopeId: original.scopeId });
    await closeRetainedLegacyLaunch(next);
    expect(send).toHaveBeenLastCalledWith({ action: 'closeIntent', teamName: original.teamName, intentId: 'TEST-rebind' });
  });

  it('cancels an exact pending rebind intent on close and never adopts its late result', async () => {
    const original = choice(), response = deferred<RetainedLegacyLaunchResult>();
    const send = vi.fn<Transport>(request => request.action === 'rebind' ? response.promise : Promise.resolve(cleanup(request)));
    const client = createRetainedLegacyLaunchClient(original, send);
    const pending = client.rebind('/TEST/next-project', 'TEST-closing-rebind');
    const rejected = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    await client.close();
    expect(send).toHaveBeenCalledWith({ action: 'closeIntent', teamName: original.teamName, intentId: 'TEST-closing-rebind' });
    response.resolve({ ok: true, action: 'rebind', value: { ...original, scopeId: original.scopeId + '-late' } });
    await rejected;
    expect(send.mock.calls.filter(([request]) => request.action === 'rebind')).toHaveLength(1);
    expect(send.mock.calls.filter(([request]) => request.action === 'closeIntent').every(([request]) =>
      request.action === 'closeIntent' && request.intentId === 'TEST-closing-rebind')).toBe(true);
  });
});
