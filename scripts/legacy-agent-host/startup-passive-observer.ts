import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bounded } from './desktop-proof-bounds.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
type Phase = 'profile-validation-start' | 'profile-validation-complete' | 'child-captured'
  | 'ready' | 'request-admitted' | 'response-accepted' | 'request-timeout';
const phases: readonly Phase[] = ['profile-validation-start', 'profile-validation-complete',
  'child-captured', 'ready', 'request-admitted', 'response-accepted', 'request-timeout'];
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};

/** One guarded public close attempt; reuse the existing failure-close observation bounds. */
export async function requestObservedDesktopClose(
  cdp: UiCdpPort,
  options: { assertOwnedRenderer(): void; onAttempt(): void; listenerPresent(): boolean;
    evidence: Row; key: 'startupDiagnosticClose' | 'failureQuit' },
): Promise<void> {
  options.assertOwnedRenderer();
  options.onAttempt(); // Set the caller's no-retry fence before invoking the public API.
  const observation: Row = { attempted: true,
    scope: 'Close only the verified TEST window before stopping its dev wrapper' };
  options.evidence[options.key] = observation;
  try {
    await bounded(cdp.evaluate('window.electronAPI.windowControls.close()'), 3000, 'owned TEST close');
    observation.reply = 'acknowledged';
  } catch (error) {
    observation.reply = 'unconfirmed';
    observation.reason = /timed out/i.test(String(error)) ? 'timeout' :
      /No handler registered/i.test(String(error)) ? 'handler-not-ready' : 'closed-or-rejected';
  }
  const closeUntil = Date.now() + 6000;
  while (Date.now() < closeUntil && options.listenerPresent())
    await new Promise<void>(done => setTimeout(done, 100));
  observation.listenerAbsent = !options.listenerPresent();
}

/** Startup only: no Team API, discovery RPC, module injection, focus or Input calls. */
export async function observeDesktopStartup(
  cdp: UiCdpPort & { on(method: string, listener: (value: unknown) => void): void },
  options: { root: string; url: string; remainingStartupMs: number;
    assertOwnedRenderer(): void; evidence: Row },
): Promise<void> {
  assert.match(options.root.split('/').at(-1)!, /^TEST-desktop-backend-/);
  assert.ok(options.remainingStartupMs > 0);
  const started = performance.now(), deadline = started + options.remainingStartupMs;
  const events: Row[] = [], commands: Row[] = [], contexts = new Map<number, unknown>();
  let mainFrameId: unknown;
  const proof: Row = { status: 'OBSERVING', scope: 'passive startup, not workflow qualification',
    targetUrlFound: true, events, commands, hostPhases: [], defaultContextObserved: false };
  options.evidence.startupDiagnostic = proof;
  const elapsed = (): number => Math.round(performance.now() - started);
  const add = (event: Row): void => { if (events.length < 128) events.push({ elapsedMs: elapsed(), ...event }); };
  const localPath = (url: unknown): string | null => {
    try { const u = new URL(String(url)); return u.origin === new URL(options.url).origin ? u.pathname.slice(0, 300) : null; }
    catch { return null; }
  };
  cdp.on('Page.frameNavigated', value => {
    const frame = row(row(value).frame);
    if (frame.parentId === undefined && localPath(frame.url) !== null) mainFrameId = frame.id;
    add({ event: 'frameNavigated', frameId: frame.id, main: frame.parentId === undefined,
      localPath: localPath(frame.url), loaderId: frame.loaderId });
  });
  for (const method of ['Page.domContentEventFired', 'Page.loadEventFired', 'Runtime.executionContextsCleared'])
    cdp.on(method, () => { if (method === 'Runtime.executionContextsCleared') contexts.clear(); add({ event: method }); });
  cdp.on('Runtime.executionContextCreated', value => {
    const context = row(row(value).context), aux = row(context.auxData);
    if (typeof context.id === 'number' && aux.isDefault === true) {
      contexts.set(context.id, aux.frameId); proof.defaultContextObserved = true;
    }
    add({ event: 'executionContextCreated', id: context.id, default: aux.isDefault === true, frameId: aux.frameId });
  });
  cdp.on('Runtime.executionContextDestroyed', value => {
    const id = row(value).executionContextId;
    if (typeof id === 'number') contexts.delete(id);
    add({ event: 'executionContextDestroyed', id });
  });
  const send = async (method: string, params?: Row): Promise<unknown> => {
    options.assertOwnedRenderer();
    const record: Row = { method, sentMs: elapsed() }; commands.push(record);
    try {
      const result = await bounded(cdp.send(method, params), Math.max(1, deadline - performance.now()), method);
      record.ackMs = elapsed(); return result;
    } catch (error) {
      record.failedMs = elapsed();
      record.failure = /timed out/i.test(String(error)) ? 'timeout' : /connection closed/i.test(String(error)) ? 'closed' : 'protocol-refused';
      return undefined;
    }
  };
  // Independent protocol subscriptions; no initial Runtime.evaluate prerequisite.
  await Promise.allSettled([send('Page.enable'), send('Runtime.enable')]);
  const frame = row(row(row(await send('Page.getFrameTree')).frameTree).frame);
  if (localPath(frame.url) !== null) mainFrameId = frame.id;
  let sampled = false;
  try {
    while (performance.now() < deadline) {
      options.assertOwnedRenderer();
      const mainContext = [...contexts].find(([, frameId]) => mainFrameId !== undefined && frameId === mainFrameId)?.[0];
      if (mainContext !== undefined && !sampled) {
        proof.mainDefaultContextObserved = true;
        sampled = true;
        const result = row(await send('Runtime.evaluate', { contextId: mainContext, awaitPromise: false,
          returnByValue: true, expression: `({readyState:document.readyState,uiDidInit:window.__claudeTeamsUiDidInit===true,rootChildren:document.getElementById('root')?.childElementCount??0})` }));
        const value = row(row(result.result).value);
        proof.rendererRead = { readyState: value.readyState, uiDidInit: value.uiDidInit, rootChildren: value.rootChildren };
      }
      try {
        const bytes = await readFile(join(options.root, 'userData/logs/app-errors.ndjson'), 'utf8');
        assert.ok(bytes.length <= 4 * 1024 * 1024);
        const markers = bytes.split('\n').flatMap(line => { try { return [row(JSON.parse(line))]; } catch { return []; } });
        proof.hostPhases = markers.filter(m => m.namespace === 'TEST:HostStartup').slice(0, 128).flatMap(m => {
          const match = /^Host startup observation (\{.*\})$/.exec(String(m.message));
          if (!match) return [];
          const v = row(JSON.parse(match[1]!));
          return phases.includes(v.phase as Phase) && ['handshake', 'rpc'].includes(String(v.kind)) ? [{ at: m.t, phase: v.phase, kind: v.kind }] : [];
        });
        proof.mainLoadMarkers = markers.filter(m => ['[startup] renderer dom-ready', '[startup] renderer did-finish-load'].includes(String(m.message))).map(m => ({ at: m.t, message: m.message }));
      } catch (error) {
        proof.logRead = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-created' : 'unavailable';
      }
      await new Promise<void>(done => setTimeout(done, 1000));
    }
  } finally {
    proof.status = 'OBSERVED'; proof.elapsedMs = elapsed(); proof.currentDefaultContextCount = contexts.size;
    proof.hostPhaseEvidencePresent = Array.isArray(proof.hostPhases) && proof.hostPhases.length > 0;
    await writeFile(join(options.root, 'startup-diagnostic.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
}
