import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, waitFor } from '../release-updater/cdp.mts';
import { captureNativeWindow, processIdentity, stopOwnedGroup } from '../release-updater/native-window.mts';
import { Fixtures } from './fixtures.mts';
import { renderer } from './renderer.mts';

import type { PageCall, RefreshObservation, RendererInput, Snapshot } from './renderer.mts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--output' && args[1] && path.isAbsolute(args[1]),
  'Usage: node scripts/e2e/sentry-inbox-provenance/run.mts --output NEW_ABSOLUTE_DIRECTORY');
assert.equal(process.platform, 'linux', 'Run only in a hosted Linux validation checkout');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ is required');
for (const file of ['/usr/bin/Xvfb', '/usr/bin/xwininfo', '/usr/bin/xprop', '/usr/bin/import',
  path.join(repo, 'node_modules/electron-vite/bin/electron-vite.js')]) {
  await access(file).catch(() => { throw new Error(`Missing prepared native prerequisite: ${file}`); });
}
const output = args[1];
await mkdir(output); // Fail closed on existing evidence directories.
const root = await mkdtemp(path.join(tmpdir(), 'sentry-inbox-fixture-'));
const rootIdentity = await stat(root);
const fixture = new Fixtures(root);
const input: RendererInput = { team: fixture.team, project: fixture.project,
  inboxDetail: path.relative(path.join(fixture.claude, 'teams', fixture.team), fixture.inbox).split(path.sep).join('/') };
const evidence: Record<string, unknown> = {
  started: new Date().toISOString(), repo, output, node: process.versions.node,
  isolation: { root, team: fixture.team, claudeRoot: fixture.claude, project: fixture.project, userData: fixture.userData },
  boundary: 'actual Electron renderer / frozen preload IPC / main getMessagesPage / synthetic inbox, lead JSONL and sent messages',
  limitations: [
    'Equal-revision live-overlay boundary movement remains a source contract check: its actual producer requires a runtime sampler; this harness does not launch agents or invent IPC payloads.',
    'Optimistic send acknowledgement remains a source contract check; no send path or provider runtime is started.',
    'Old-incarnation R2 explicit-demand rehydration remains unit/source-contract coverage; this desktop run does not manipulate incarnation epochs or claim an actual R2 E2E result.',
    'This run verifies PR3a provenance and PR3b producer inbox failure/recovery; it does not establish memory budgets or evicted-range retrieval.',
    'Real optimistic acknowledgement remains OPEN. Failure retention checks preserve the existing empty optimistic list and do not claim real pending-send coverage.',
  ],
  cases: [],
};
type Owner = NonNullable<Awaited<ReturnType<typeof processIdentity>>>;
const owners: { label: string; owner: Owner }[] = [];
let cdp: Cdp | undefined;
let launchLog = Buffer.alloc(0), droppedBytes = 0, droppedEvents = 0;
let rendererExceptionCount = 0;
let documentEpoch = 0;
let scenarioDocumentEpoch: number | null = null;
let mainFrameId: string | undefined;
const expectedErrorCalls = new Set<number>();
const rendererExceptions: Cdp['events'] = [];
let signal: NodeJS.Signals | null = null;
const interrupted = (received: NodeJS.Signals) => { signal = received; };
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
const oldDisplay = process.env.DISPLAY;
function appendLog(chunk: Buffer) {
  const joined = Buffer.concat([launchLog, chunk]);
  const excess = Math.max(0, joined.length - 1_048_576);
  droppedBytes += excess;
  launchLog = joined.subarray(excess);
}
const checks: (() => void)[] = [];
function check() {
  assert(!signal, `Interrupted by ${signal}`);
  assert(scenarioDocumentEpoch === null || documentEpoch === scenarioDocumentEpoch,
    'Scenario renderer navigated after observation started; refusing to replay UI or IPC operations');
  for (const checkChild of checks) checkChild();
}
async function launch(label: string, command: string, launchArgs: string[], env: NodeJS.ProcessEnv) {
  check();
  const child = spawn(command, launchArgs, { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  checks.push(() => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited: ${launchLog.subarray(-6000)}`);
  });
  assert(child.pid, `${label} did not create a PID`);
  // Birth identity is captured before any interruption check, so cleanup still
  // owns a launch interrupted immediately after spawn.
  const owner = await processIdentity(child.pid);
  assert(owner, `${label} exited before ownership capture`);
  assert.equal(owner.group, owner.pid, 'Launch must own a detached process group');
  owners.push({ label, owner });
  return child;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function call<T = unknown>(action: string, extra: Partial<RendererInput> = {}) {
  check();
  assert(cdp, 'Owned Electron CDP must be connected');
  const result = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description: string } } }>('Runtime.evaluate', {
    expression: `(${renderer.toString()})(${JSON.stringify(action)}, ${JSON.stringify({ ...input, ...extra })})`,
    returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  check();
  return result.result.value;
}
async function prepareColdDesktop() {
  const attempts: unknown[] = [];
  evidence.coldDevPreparation = attempts;
  const ready = () => call<boolean>('ready').catch(error => {
    if (/Execution context|Cannot find context|Inspected target navigated|Promise was collected/i.test(String(error))) return false;
    throw error;
  });
  const optimizationReloads = () => launchLog.toString().split('optimized dependencies changed. reloading').length - 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const beforeEpoch = documentEpoch, beforeReloads = optimizationReloads();
    let failure: unknown;
    try { await call('warm'); } catch (error) { failure = String(error); }
    // Vite's optimizer sends the full-reload websocket message asynchronously
    // after lazy-module imports. This bounded startup window catches the exact
    // cold dependency reload observed in r2, before any scenario action exists.
    await new Promise(resolve => setTimeout(resolve, 1000));
    check();
    const initiallyReloaded = documentEpoch !== beforeEpoch || optimizationReloads() !== beforeReloads;
    if (failure && !initiallyReloaded) throw new Error(`Read-only UI module warmup failed without a dev reload: ${String(failure)}`);
    await waitFor(async () => await ready() || null, 'cold-dev renderer bootstrap after read-only UI import');
    // Ready can span a context teardown/reload. Re-read both signals after it
    // settles; never admit a new document using the previous document's import.
    const reloaded = documentEpoch !== beforeEpoch || optimizationReloads() !== beforeReloads;
    attempts.push({ attempt, beforeEpoch, afterEpoch: documentEpoch, optimizationReloads: optimizationReloads(), failure, reloaded });
    if (!reloaded) return;
    assert(optimizationReloads() > beforeReloads, 'Unexpected bootstrap navigation is not an observed Vite optimization reload');
  }
  throw new Error('Cold-dev UI dependency discovery exceeded three bounded read-only attempts');
}
async function snapshot() { return call<Snapshot>('snapshot'); }
async function visibleText(text: string) {
  // IPC/store completion precedes React's commit. Observe the exact actual DOM
  // result without replaying navigation, paging, sends or fixture mutations.
  return waitFor(async () => {
    const value = await snapshot();
    return !value.loadingHead && !value.loadingOlder && value.gate?.pending === 0 &&
      value.visibleText.includes(text) ? value : null;
  }, `actual committed UI text: ${text}`);
}
async function visibleButton(label: string) {
  return waitFor(async () => {
    const value = await snapshot();
    return value.buttons.some(button => !button.disabled && (button.text === label || button.label === label)) ? value : null;
  }, `actual committed UI button: ${label}`);
}
async function idle() {
  return waitFor(async () => {
    const value = await snapshot();
    return value.teamLoaded === fixture.team && !value.teamLoading && !value.loadingHead && !value.loadingOlder &&
      value.gate?.pending === 0 && value.head.length === 50 ? value : null;
  }, 'real IPC continuations and UI team data settled');
}
function assertHead(value: Snapshot) {
  assert.deepEqual(value.head.map(message => message.id), fixture.expectedHeadIds(), 'Main page must use newest-first order and stable same-timestamp ID ties');
  assert.equal(value.head.length, 50);
  assert.equal(value.teamError, null);
  assert.equal(value.optimistic.length, 0);
  const referenced = value.head.find(message => message.id === 'sentry-inbox-0120');
  assert.deepEqual(referenced?.taskRefs, [{ taskId: 'fixture-task', displayId: '42', teamName: fixture.team }], 'Structured task refs must survive real IPC and cache projection');
}
async function checkpoint(label: string, value: Snapshot) {
  assert(cdp);
  const png = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, `${label}.png`), Buffer.from(png.data, 'base64'));
  const { gate, ...state } = value;
  (evidence.cases as unknown[]).push({ label, ...state, pageCalls: gate?.calls.length, pending: gate?.pending });
  process.stdout.write(`PASS ${label}\n`);
}
async function click(label: string) {
  await waitFor(async () => (await snapshot()).buttons.some(button => !button.disabled &&
    (button.text === label || button.label === label || button.label?.startsWith(`${label}, `))) ? true : null,
  `actual visible ${label} button`);
  await call('click', { label });
}
async function revealLocalHistory() {
  const reveals = (evidence.localHistoryReveals ??= []) as unknown[];
  const hiddenCount = (value: Snapshot) => value.historyControls.reduce((total, text) =>
    total + Number(/\+(\d+) older/.exec(text)?.[1] ?? 0), 0);
  for (let reveal = 0; reveal < 10; reveal++) {
    const before = await snapshot();
    const buttons = before.buttons.filter(button => !button.disabled && /^Show \d+ more$/.test(button.text ?? ''));
    if (buttons.length === 0) return;
    assert.equal(buttons.length, 1, 'One actual conversation local-window reveal control must be visible');
    const label = buttons[0]?.text;
    assert(label && hiddenCount(before) > 0, 'Local reveal must describe a loaded hidden history range');
    const cursorCalls = before.gate?.calls.filter(call => call.cursor).length;
    await click(label);
    const after = await waitFor(async () => {
      const next = await snapshot();
      return hiddenCount(next) < hiddenCount(before) ? next : null;
    }, 'actual local Show more reveals already loaded messages');
    assert.equal(after.gate?.calls.filter(call => call.cursor).length, cursorCalls,
      'Local Show more must send no cursor IPC');
    assert.deepEqual(after.canonical, before.canonical, 'Local reveal must preserve the bounded loaded cache');
    assert.deepEqual(after.pages, before.pages, 'Local reveal must not acquire remote page provenance');
    assert.equal(after.revision, before.revision);
    assertHead(after);
    reveals.push({ label, hiddenBefore: hiddenCount(before), hiddenAfter: hiddenCount(after), cursorCalls, loadedMessages: after.canonical.length });
  }
  throw new Error('Local conversation history exceeded ten bounded visible-control reveals');
}
async function manualOlder(expectedPages: number) {
  await revealLocalHistory();
  const before = await snapshot();
  await click('Load older messages');
  const value = await waitFor(async () => {
    const next = await snapshot();
    return next.pages.length === expectedPages && !next.loadingOlder && next.gate?.pending === 0 ? next : null;
  }, 'explicit UI older page commits');
  const requested = value.gate?.calls.slice(before.gate?.calls.length ?? 0).filter(call => call.cursor);
  assert(requested, 'Actual IPC observer must remain installed');
  assert.equal(requested.length, 1, 'One click must demand exactly one actual older IPC page');
  assert.equal(requested[0]?.cursor, before.nextCursor);
  assert(value.pages.every(page => page.sourceRevision === value.revision));
  assert.equal(value.pages[expectedPages - 1]?.inputCursor, before.nextCursor);
  return value;
}
function assertRetainedHistory(before: Snapshot, after: Snapshot) {
  for (const field of ['head', 'canonical', 'pages', 'optimistic', 'revision', 'nextCursor',
    'hasMore', 'provenanceScope', 'headHydrated'] as const) {
    assert.deepEqual(after[field], before[field], `Source failure must preserve trusted ${field}`);
  }
  assert.equal(after.loadingHead, false); assert.equal(after.loadingOlder, false);
  assertHead(after);
}
async function unavailableHistory() {
  return waitFor(async () => {
    const value = await snapshot();
    return !value.loadingHead && !value.loadingOlder && value.gate?.pending === 0 &&
      value.error === 'TEAM_HISTORY_UNAVAILABLE:invalid_json' &&
      value.notices.some(text => text === 'Could not load message history. Previously loaded messages are still available.') ? value : null;
  }, 'actual IPC source failure commits history-unavailable notice');
}
function recordOwnedFailureCalls(start: number, calls: PageCall[] | undefined, phase: PageCall['sourceFailurePhase']) {
  assert(calls, 'Real IPC observer must remain installed during source failure');
  let failed = 0;
  for (let index = start; index < calls.length; index++) {
    const observed: PageCall | undefined = calls[index];
    if (!observed?.error) continue;
    assert.equal(observed.fulfilled, false);
    assert.equal(observed.sourceFailurePhase, phase, 'Expected rejection must originate inside its owned corruption phase');
    assert.equal(observed.page, undefined, 'Failed IPC must never publish a successful partial page');
    assert.match(observed.error, /^Error: TEAM_HISTORY_UNAVAILABLE:invalid_json$/);
    assert(!observed.error.includes(root), 'Failure transport must not expose filesystem paths');
    expectedErrorCalls.add(index); failed++;
  }
  assert(failed > 0, 'Owned corruption must produce an observed actual IPC rejection');
}
async function inboxInvalidated(before: Snapshot, phase: string): Promise<Snapshot> {
  assert(before.gate, 'Owned watcher observer must be installed');
  const previousCount = before.gate.inboxChangeCount;
  const notified: Snapshot = await waitFor(async () => {
    const value: Snapshot = await snapshot();
    return value.gate && value.gate.inboxChangeCount > previousCount ? value : null;
  }, `actual owned inbox invalidation event: ${phase}`);
  assert.equal(notified.gate?.droppedInboxChanges, 0, 'Bounded observer must retain all owned invalidation events');
  const events = notified.gate?.inboxChanges.slice(previousCount);
  assert(events?.length && events.every(event => event.detail === input.inboxDetail));
  const fences = (evidence.sourceInvalidationFences ??= []) as unknown[];
  assert(fences.length < 4, 'Only the four owned source mutations require invalidation fences');
  fences.push({ phase, beforeCount: previousCount, afterCount: notified.gate?.inboxChangeCount, events });
  // Main invalidation and worker invalidation dispatch precede TEAM_CHANGE.
  // Observe real IPC completion before issuing the single explicit demand.
  return idle();
}
async function verifySourceFailureRecovery() {
  await revealLocalHistory(); await visibleButton('Load older messages');
  const trusted = await idle();
  assert.equal(trusted.pages.length, 1); assert.equal(trusted.hasMore, true); assert(trusted.nextCursor);
  await call('sourcePhase', { sourceFailurePhase: 'head-malformed' });
  const firstCall = trusted.gate?.calls.length ?? 0;
  const receipt = await fixture.corruptInbox('malformed-suffix');
  await inboxInvalidated(trusted, 'malformed-head');
  const observed = await call<RefreshObservation>('observeRefresh');
  assert.equal(observed.rejected, true, 'Explicit head refresh must reject the real invalid source');
  assert.match(observed.error ?? '', /TEAM_HISTORY_UNAVAILABLE:invalid_json$/);
  let failed = await unavailableHistory();
  assertRetainedHistory(trusted, failed);
  await checkpoint('malformed-head-retains-trusted-history', failed);
  await fixture.persist();
  const headRestored = await inboxInvalidated(failed, 'restore-head');
  recordOwnedFailureCalls(firstCall, headRestored.gate?.calls, 'head-malformed');
  await call('sourcePhase', { sourceFailurePhase: null });
  await call('refresh');
  let recovered = await waitFor(async () => {
    const value = await snapshot();
    return !value.loadingHead && value.gate?.pending === 0 && value.error === null &&
      !value.notices.some(text => text === 'Could not load message history. Previously loaded messages are still available.') ? value : null;
  }, 'explicit restored head retry clears actual UI error');
  assertRetainedHistory(trusted, recovered);
  recordOwnedFailureCalls(firstCall, recovered.gate?.calls, 'head-malformed');
  await checkpoint('restored-head-explicit-retry', recovered);
  const pagingTrusted = recovered;
  const nextCall = pagingTrusted.gate?.calls.length ?? 0;
  await call('sourcePhase', { sourceFailurePhase: 'older-nonarray' });
  const nonArray = await fixture.corruptInbox('non-array');
  await inboxInvalidated(pagingTrusted, 'nonarray-older');
  await click('Load older messages');
  failed = await unavailableHistory();
  assertRetainedHistory(pagingTrusted, failed);
  const olderFailures = failed.gate?.calls.slice(nextCall).filter(call => call.cursor);
  assert.equal(olderFailures?.length, 1, 'One explicit older click must produce exactly one real cursor request');
  assert.equal(olderFailures?.[0]?.cursor, pagingTrusted.nextCursor);
  assert.match(olderFailures?.[0]?.error ?? '', /TEAM_HISTORY_UNAVAILABLE:invalid_json$/);
  await checkpoint('nonarray-older-retains-trusted-history', failed);
  await fixture.persist();
  const olderRestored = await inboxInvalidated(failed, 'restore-older');
  recordOwnedFailureCalls(nextCall, olderRestored.gate?.calls, 'older-nonarray');
  await call('sourcePhase', { sourceFailurePhase: null });
  recovered = await manualOlder(2);
  recordOwnedFailureCalls(nextCall, recovered.gate?.calls, 'older-nonarray');
  assert.equal(recovered.error, null); assert.equal(recovered.historyReloadRequired, false);
  assert.deepEqual(recovered.pages[0], pagingTrusted.pages[0]);
  assert.deepEqual(recovered.pages[1]?.inputCursor, pagingTrusted.nextCursor);
  assert.deepEqual(recovered.canonical.map(message => message.id), fixture.expectedFeedIds(), 'Explicit retry must recover complete actual fixture history exactly once');
  assert.equal(recovered.hasMore, false); assert.equal(recovered.nextCursor, null);
  await checkpoint('restored-older-explicit-retry', recovered);
  evidence.sourceFailureFixtures = [receipt, nonArray];
}

try {
  await fixture.prepare();
  // Xvfb chooses a fresh free display. No existing user's display/session is used.
  const xvfb = await launch('isolated Xvfb', '/usr/bin/Xvfb', ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp', '-noreset'], process.env);
  let display = '';
  xvfb.stdio[3]?.on('data', (chunk: Buffer) => { display += chunk.toString(); assert(display.length < 128); });
  await waitFor(async () => { check(); return /^\d+\n$/.test(display) ? true : null; }, 'fresh Xvfb display');
  process.env.DISPLAY = `:${display.trim()}`;
  evidence.display = process.env.DISPLAY;
  const port = await freePort();
  evidence.port = port;
  const launchArgs = ['node_modules/electron-vite/bin/electron-vite.js', 'dev', '--remoteDebuggingPort', String(port), '--noSandbox'];
  evidence.launch = { command: process.execPath, args: launchArgs };
  await launch('Electron desktop', process.execPath, launchArgs, {
    ...process.env, NODE_ENV: 'development', ELECTRON_RUN_AS_NODE: '', AGENT_TEAMS_ORG_DEMO: '0',
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: fixture.claude, AGENT_TEAMS_ELECTRON_USER_DATA_DIR: fixture.userData,
  });
  const appOwner = owners.find(item => item.label === 'Electron desktop')?.owner;
  assert(appOwner);
  await waitFor(async () => { check(); return launchLog.includes(`DevTools listening on ws://127.0.0.1:${port}/`) ? true : null; }, 'fresh desktop CDP port', 180_000);
  const target = await waitFor(async () => {
    check();
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
      return targets.find(item => item.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(item.url)) ?? null;
    } catch { return null; }
  }, 'actual owned desktop renderer');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const frameTree = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
  mainFrameId = frameTree.frameTree.frame.id;
  const events = cdp.events, push = events.push;
  events.push = (...items) => {
    for (const item of items) if (item.method === 'Page.frameStartedNavigating' &&
      (item.params as { frameId?: string })?.frameId === mainFrameId) documentEpoch++;
    for (const item of items) if (item.method === 'Runtime.exceptionThrown') {
      rendererExceptionCount++;
      if (rendererExceptions.length < 20) rendererExceptions.push(item);
    }
    push.apply(events, items);
    const excess = Math.max(0, events.length - 2000);
    if (excess) { events.splice(0, excess); droppedEvents += excess; }
    return events.length;
  };
  await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Page.enable');
  await waitFor(async () => await call<boolean>('ready') || null, 'Electron preload and existing DEV store');
  await prepareColdDesktop();
  evidence.native = await captureNativeWindow(appOwner, output);
  scenarioDocumentEpoch = documentEpoch;
  evidence.scenarioDocumentEpoch = scenarioDocumentEpoch;
  await call('install');
  await call('open');
  let value = await idle();
  assertHead(value);
  assert.equal(value.pages.length, 0);
  await click('Group chat');
  await checkpoint('initial-real-head', await visibleButton('Back to chats'));
  for (let batch = 0; batch < 2; batch++) {
    fixture.append(5); await fixture.persist();
    await waitFor(async () => {
      await call('refresh');
      const next = await idle();
      return next.head[0]?.id === fixture.expectedHeadIds()[0] ? next : null;
    }, 'actual durable append reaches head');
    value = await idle();
    assertHead(value);
    assert.equal(value.pages.length, 0, 'Polling must never promote displaced head into history');
    assert.equal(value.canonical.length, 50, 'Polling retains exactly the current head before explicit paging');
  }
  const appended = fixture.messages.at(-1);
  assert(appended);
  value = await visibleText(appended.text);
  await checkpoint('append-bounded-head', value);
  value = await manualOlder(1);
  assert.equal(value.canonical.length, 100);
  assert(value.pages[0]?.messages.some(message => message.from === 'alice'));
  await checkpoint('explicit-ui-page', value);
  await verifySourceFailureRecovery();
  await click('Back to chats'); await click('alice');
  value = await visibleText('SENTRY_ALICE_0069');
  assert(value.visibleText.includes('SENTRY_ALICE_0069'), 'Actual direct thread must render an explicitly loaded Alice message');
  const olderCalls = value.gate?.calls.filter(call => call.cursor).length;
  fixture.append(10); await fixture.persist();
  await waitFor(async () => { await call('refresh'); const next = await idle(); return next.revision !== value.revision ? next : null; }, 'Bob append changes feed revision');
  value = await visibleText('No messages in this chat');
  assertHead(value);
  assert.equal(value.pages.length, 0);
  assert.equal(value.historyReloadRequired, true);
  assert(value.notices.some(text => text?.includes('Message history changed.')));
  assert(value.visibleText.includes('No messages in this chat'), 'Invalidated Alice history must leave the actual direct thread empty');
  // Flush the React passive effects through a real renderer task, then repeat
  // real head polls. The empty direct scope must not demand history implicitly.
  for (let poll = 0; poll < 3; poll++) { await call('refresh'); value = await idle(); }
  assert.equal(value.gate?.calls.filter(call => call.cursor).length, olderCalls, 'Empty Alice thread must not silently auto-page after revision invalidation');
  await checkpoint('alice-invalidation-no-autopage', value);
  value = await manualOlder(1);
  value = await visibleText('SENTRY_ALICE_0069');
  assert.equal(value.historyReloadRequired, false); assert.equal(value.error, null);
  assert(value.visibleText.includes('SENTRY_ALICE_0069'));
  await checkpoint('alice-explicit-reload', value);
  const previousRevision = value.revision;
  fixture.rewriteAlice(); await fixture.persist();
  await waitFor(async () => { await call('refresh'); const next = await idle(); return next.revision !== previousRevision ? next : null; }, 'actual older-source rewrite changes revision');
  value = await idle();
  assert.equal(value.pages.length, 0); assert.equal(value.historyReloadRequired, true);
  value = await visibleText('Message history changed.');
  assert(value.notices.some(text => text?.includes('Message history changed.')));
  value = await manualOlder(1);
  value = await visibleText('SENTRY_ALICE_REWRITTEN_0069');
  assert(value.canonical.some(message => message.text === 'SENTRY_ALICE_REWRITTEN_0069'));
  assert(value.visibleText.includes('SENTRY_ALICE_REWRITTEN_0069'), 'Manual UI reload must display rewritten durable content');
  assert.equal(value.error, null);
  await checkpoint('rewrite-notice-manual-reload', value);
  await click('Back to chats'); await click('Group chat');
  await visibleButton('Back to chats');
  await revealLocalHistory();
  await call('holdOlder'); await click('Load older messages');
  const held = await waitFor(async () => { const next = await snapshot(); return next.gate?.waiting === 1 ? next : null; }, 'fulfilled real older IPC held for race');
  assert.equal(held.loadingOlder, true);
  fixture.append(2); await fixture.persist();
  await call('startRefresh'); await call('release'); await call('awaitRefresh');
  await waitFor(async () => { await call('refresh'); const next = await idle(); return next.revision !== held.revision ? next : null; }, 'queued head poll follows held older response');
  value = await idle();
  assertHead(value); assert.equal(value.pages.length, 0); assert.equal(value.canonical.length, 50);
  assert.equal(value.historyReloadRequired, true);
  await checkpoint('real-ipc-paging-poll-race', value);
  for (let page = 1; page <= 3; page++) value = await manualOlder(page);
  assert.equal(value.hasMore, false);
  assert.deepEqual(value.canonical.map(message => message.id), fixture.expectedFeedIds(), 'Complete ordered main feed includes inbox, sent store, lead JSONL and generated bootstrap rows');
  assert(value.canonical.some(message => message.text === 'SENTRY_SENT_FIXTURE' && message.source === 'user_sent'));
  assert(value.canonical.some(message => message.text === fixture.leadText && message.source === 'lead_session'));
  for (const member of ['alice', 'bob']) {
    const bootstrap = value.canonical.find(message => message.id === `bootstrap-start:${fixture.team}:${member}`);
    assert(bootstrap, 'Real generated bootstrap row must remain in complete history');
    assert.equal(bootstrap.from, 'team-lead'); assert.equal(bootstrap.to, member);
    assert.equal(bootstrap.source, 'system_notification'); assert.equal(bootstrap.timestamp, fixture.bootstrapTimestamp);
  }
  await call('member');
  value = await waitFor(async () => { const next = await snapshot(); return next.dialogs.some(text => text?.includes('SENTRY_ALICE_REWRITTEN_0069')) ? next : null; }, 'actual MemberMessagesTab shows durable rewritten Alice history');
  await checkpoint('actual-member-history', value);
  evidence.actualPageCalls = value.gate?.calls;
  evidence.droppedPageCalls = value.gate?.droppedCalls;
  evidence.inboxChangeCapture = { count: value.gate?.inboxChangeCount, events: value.gate?.inboxChanges,
    dropped: value.gate?.droppedInboxChanges, limit: 120 };
  assert.equal(value.gate?.droppedInboxChanges, 0, 'Owned inbox event bound must not truncate this small scenario');
  assert.equal(value.gate?.droppedCalls, 0, 'Evidence call bound must not truncate this small scenario');
  assert(value.gate?.calls.every((call, index) => expectedErrorCalls.has(index)
    ? !call.fulfilled && call.error === 'Error: TEAM_HISTORY_UNAVAILABLE:invalid_json' && !call.page
    : call.fulfilled && !call.error), 'Only recorded owned-corruption IPC rejections may fail; all other actual pages must succeed');
  evidence.expectedSourceErrorCalls = [...expectedErrorCalls];
  assert.equal(rendererExceptionCount, 0, 'Actual renderer must not raise unhandled exceptions');
  check();
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
  if (cdp) {
    evidence.failureSnapshot = await snapshot().catch(String);
    const png = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (png) await writeFile(path.join(output, 'failure.png'), Buffer.from(png.data, 'base64'));
  }
} finally {
  if (cdp) {
    await cdp.evaluate("(() => { const g = window.__sentryInboxGate; if (g) { g.release(); g.unsubscribeInbox(); Reflect.get = g.originalGet; delete window.__sentryInboxGate; } })()").catch(error => { evidence.restoreFailure = String(error); process.exitCode = 1; });
    evidence.events = cdp.events; cdp.close();
  }
  const cleanup: unknown[] = [];
  for (const owned of [...owners].reverse()) {
    try { cleanup.push({ label: owned.label, ...await stopOwnedGroup(owned.owner) }); }
    catch (error) { evidence.cleanupFailure = String(error); process.exitCode = 1; }
  }
  evidence.owners = owners; evidence.cleanup = cleanup;
  if (!evidence.cleanupFailure) {
    try {
      const fresh = await stat(root);
      assert.equal(fresh.dev, rootIdentity.dev); assert.equal(fresh.ino, rootIdentity.ino);
      await rm(root, { recursive: true, force: false }); evidence.fixtureRemoved = true;
    } catch (error) { evidence.cleanupFailure = String(error); process.exitCode = 1; }
  }
  if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay;
  await writeFile(path.join(output, 'desktop.log'), launchLog);
  evidence.logCapture = { retainedBytes: launchLog.length, droppedBytes, limitBytes: 1_048_576 };
  evidence.eventCapture = { droppedEvents, limit: 2000 };
  evidence.rendererExceptionCount = rendererExceptionCount;
  evidence.rendererExceptions = rendererExceptions;
  evidence.documentEpoch = documentEpoch;
  const workerArtifact = path.join(repo, 'dist-electron/main/team-data-worker.cjs');
  let workerArtifactReadFailure: string | null = null;
  const workerData = await readFile(workerArtifact).catch(error => {
    workerArtifactReadFailure = (error as NodeJS.ErrnoException).code ?? String(error);
    return null;
  });
  const workerRejectLogs = launchLog.toString().split('\n').filter(line =>
    line.includes('[teams:getMessagesPage] worker failed, falling back: TEAM_HISTORY_UNAVAILABLE:invalid_json')).slice(-20);
  evidence.workerRoute = {
    artifact: workerArtifact, artifactSha256: workerData ? createHash('sha256').update(workerData).digest('hex') : null,
    artifactReadFailure: workerArtifactReadFailure,
    actualRejectFallbackLogs: workerRejectLogs,
    coverage: workerRejectLogs.length ? 'observed-worker-rejection-and-main-fallback'
      : workerArtifactReadFailure === 'ENOENT' ? 'main-only-worker-unavailable' : 'worker-route-unverified',
  };
  if (!workerRejectLogs.length) (evidence.limitations as string[]).push('Actual worker rejection was not observed; worker coverage is not claimed by this desktop result.');
  const files = ['scripts/e2e/sentry-inbox-provenance/run.mts', 'scripts/e2e/sentry-inbox-provenance/renderer.mts',
    'scripts/e2e/sentry-inbox-provenance/fixtures.mts', 'tsconfig.sentry-inbox-e2e.json',
    'package.json', 'scripts/e2e/release-updater/cdp.mts', 'scripts/e2e/release-updater/native-window.mts',
    'src/renderer/store/team/teamMessagesProvenance.ts', 'src/renderer/store/team/teamMessagesCache.ts',
    'src/renderer/components/team/messages/useMessagesPanelChats.ts', 'src/renderer/components/team/messages/MessagesPanel.tsx',
    'src/renderer/components/team/members/MemberMessagesTab.tsx',
    'src/main/services/team/TeamMessageFeedService.ts', 'src/main/services/team/TeamInboxReader.ts',
    'src/renderer/components/team/messages/MessageHistoryNotice.tsx',
    'src/features/team-message-history/core/domain/messageSemantics.ts',
    'src/features/team-message-history/core/domain/pageProgress.ts',
    'src/features/team-message-history/main/application/inboxWindowRead.ts',
    'src/features/team-message-history/main/infrastructure/messageRevision.ts', 'src/main/ipc/teams.ts'];
  evidence.sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex')])));
  evidence.finished = new Date().toISOString();
  if (signal) { evidence.interrupted = signal; process.exitCode = 1; }
  if (process.exitCode) evidence.status = 'failed';
  evidence.exitCode = process.exitCode ?? 0;
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  process.stdout.write(`Desktop inbox evidence: ${path.join(output, 'evidence.json')}\n`);
  if (process.exitCode) process.stderr.write(`${String(evidence.failure ?? evidence.cleanupFailure ?? evidence.restoreFailure)}\n`);
}
