// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { Window } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { captureRetainedDonorUiFailure } from '../../scripts/legacy-agent-host/desktop-retained-opencode-app.ts';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});
const realWrite = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=';
type App = Parameters<typeof captureRetainedDonorUiFailure>[0];
let root: string;
let page: Window;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'TEST-retained-donor-diagnostic-'));
  page = new Window();
  vi.mocked(writeFile).mockReset().mockImplementation(realWrite);
  page.document.body.innerHTML = `<section data-testid="create-team-page">
    <input id="team-name" value="TEST-donor"><input aria-label="Custom working directory" value="${'c'.repeat(1100)}">
    <button id="solo-team" aria-checked="true"></button><div data-role="lead-row">${'m'.repeat(600)}</div>
    <div class="grow">${'<p role="alert">'.concat('e'.repeat(500), '</p>').repeat(10)}
    ${'<button disabled>Create</button>'.repeat(10)}</div></section>`;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  page.document.body.replaceChildren();
  await page.happyDOM.close();
  await rm(root, { recursive: true, force: true });
});

function fixture(revokeAt = Infinity) {
  const events: string[] = [];
  const apiAccess = vi.fn(() => { throw new Error('unexpected product access'); });
  const { document, HTMLElement, HTMLInputElement } = page;
  const evaluate = vi.fn((expression: string): Promise<unknown> => {
    events.push('dom');
    return Promise.resolve(runInNewContext(expression, {
      document, HTMLElement, HTMLInputElement, window: new Proxy({}, { get: apiAccess }),
    }) as unknown);
  });
  const send = vi.fn((method: string, params?: Record<string, unknown>): Promise<unknown> => {
    events.push('screenshot');
    expect(method).toBe('Page.captureScreenshot');
    expect(params).toEqual({ format: 'png', fromSurface: true });
    return Promise.resolve({ data: PNG });
  });
  let checks = 0;
  const app: App = {
    original: { pid: 1, ppid: 0, group: 1, birth: 'TEST-1', state: 'R' },
    electron: { pid: 2, ppid: 1, group: 1, birth: 'TEST-2', state: 'R' },
    assertCurrent() { events.push('owner'); if (++checks >= revokeAt) throw new Error('owner revoked'); },
    cdp: {
      evaluate: async <T>(expression: string) => await evaluate(expression) as T,
      send: async <T>(method: string, params?: Record<string, unknown>) => await send(method, params) as T,
    },
  };
  return { app, events, apiAccess, evaluate, send,
    run: () => captureRetainedDonorUiFailure(app, root, { kind: 'donor', sourceCommit: 'TEST-source' }) };
}

it('captures bounded actual DOM and a PNG under the original epoch and ownership', async () => {
  const f = fixture(), result = await f.run();
  expect(result).toMatchObject({ status: 'INCOMPLETE', atomicWithFailure: false,
    epoch: 'donor', sourceCommit: 'TEST-source', original: f.app.original, electron: f.app.electron });
  const form = result.form as { formText: string; footerText: string; errors: string[]; buttons: unknown[] };
  expect(form).toMatchObject({ status: 'observed', solo: 'true', teamName: { value: 'TEST-donor' },
    cwd: { value: 'c'.repeat(1000) }, lead: 'm'.repeat(500) });
  expect(form.formText).toHaveLength(4000); expect(form.footerText).toHaveLength(4000);
  expect(form.errors).toEqual(Array.from({ length: 8 }, () => 'e'.repeat(300)));
  expect(form.buttons).toHaveLength(8);
  expect(form.buttons[0]).toEqual({ text: 'Create', disabled: true, ariaDisabled: null });
  const path = join(root, 'donor-history-failure.png'), bytes = await readFile(path);
  expect(bytes).toEqual(Buffer.from(PNG, 'base64'));
  expect(result.screenshot).toEqual({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  expect(f.events).toEqual(['owner', 'dom', 'owner', 'owner', 'screenshot', 'owner']);
  expect(f.apiAccess).not.toHaveBeenCalled(); expect(writeFile).toHaveBeenCalledTimes(1);
});

it.each(['dom', 'screenshot'] as const)('keeps an independent observation after %s rejection', async (phase) => {
  const f = fixture();
  (phase === 'dom' ? f.evaluate : f.send).mockRejectedValueOnce(new Error('TEST observer refusal'));
  const result = await f.run();
  expect(result[phase === 'dom' ? 'form' : 'screenshot']).toMatchObject({ unavailable: true, error: 'TEST observer refusal' });
  expect(result[phase === 'dom' ? 'screenshot' : 'form']).not.toHaveProperty('unavailable');
  expect(writeFile).toHaveBeenCalledTimes(phase === 'dom' ? 1 : 0);
});

it.each([1, 2, 4])('rejects ownership revoked at check %i without publishing an image', async (check) => {
  const f = fixture(check), result = await f.run();
  expect(result.screenshot).toMatchObject({ unavailable: true, error: 'owner revoked' });
  expect(writeFile).not.toHaveBeenCalled();
  expect(f.evaluate).toHaveBeenCalledTimes(check === 1 ? 0 : 1);
  expect(f.send).toHaveBeenCalledTimes(check === 4 ? 1 : 0);
  expect(result.form).toMatchObject(check === 4 ? { status: 'observed' } : { unavailable: true });
});

it.each(['dom', 'screenshot', 'write'] as const)('bounds pending %s and ignores its late completion', async (phase) => {
  vi.useFakeTimers();
  const f = fixture(), deferred = Promise.withResolvers<unknown>(), cleanup = vi.fn();
  if (phase === 'dom') f.evaluate.mockReturnValueOnce(deferred.promise);
  if (phase === 'screenshot') f.send.mockReturnValueOnce(deferred.promise);
  if (phase === 'write') vi.mocked(writeFile).mockImplementationOnce(async () => { await deferred.promise; });
  const pending = f.run().finally(cleanup);
  const late = phase === 'dom' ? { status: 'observed', late: true } : { data: PNG };
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(phase === 'write' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(phase === 'dom' ? 4000 : 5000);
    const result = await pending, beforeLate = structuredClone(result);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result[phase === 'dom' ? 'form' : 'screenshot']).toMatchObject({ unavailable: true });
    expect(writeFile).toHaveBeenCalledTimes(phase === 'screenshot' ? 0 : 1);
    deferred.resolve(late); await deferred.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(beforeLate);
    expect(writeFile).toHaveBeenCalledTimes(phase === 'screenshot' ? 0 : 1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    if (phase === 'write') expect(result.screenshot).not.toHaveProperty('sha256');
  } finally {
    deferred.resolve(late); await deferred.promise;
    await pending;
  }
});
