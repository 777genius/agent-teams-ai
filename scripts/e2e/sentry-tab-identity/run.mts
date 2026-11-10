import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, waitFor } from '../release-updater/cdp.mts';
import { captureNativeWindow, processIdentity, stopOwnedGroup } from '../release-updater/native-window.mts';
import { renderer } from './renderer.mts';

import type { RendererInput, Snapshot } from './renderer.mts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const argumentsList = process.argv.slice(2);
let outputArgument: string | undefined;
let scenarioArgument = 'all';
for (let index = 0; index < argumentsList.length; index += 2) {
  const option = argumentsList[index], value = argumentsList[index + 1];
  assert(value && (option === '--output' || option === '--scenario'), 'Usage: node run.mts [--output NEW_ABSOLUTE_DIRECTORY] [--scenario cache|aba|all]');
  if (option === '--output') outputArgument = value;
  else scenarioArgument = value;
}
assert(['cache', 'aba', 'all'].includes(scenarioArgument), 'Unknown scenario');
const scenarios = scenarioArgument === 'all' ? ['cache', 'aba'] : [scenarioArgument];
assert.equal(process.platform, 'linux', 'Native desktop E2E requires Linux hosted validation checkout');
assert(process.env.DISPLAY, 'Start an isolated Xvfb display before running desktop E2E');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ is required for typed harness and native WebSocket');
for (const file of ['/usr/bin/xwininfo', '/usr/bin/xprop', '/usr/bin/import', path.join(repo, 'node_modules/electron-vite/bin/electron-vite.js')]) {
  await access(file).catch(() => { throw new Error(`Missing native prerequisite: ${file}`); });
}
const output = outputArgument ? path.resolve(outputArgument) : await mkdtemp(path.join(tmpdir(), 'sentry-tab-evidence-'));
if (outputArgument) { assert(path.isAbsolute(outputArgument)); await mkdir(output); }
const root = await mkdtemp(path.join(tmpdir(), 'sentry-tab-fixture-'));
const rootIdentity = await stat(root);
const claude = path.join(root, 'claude');
const project = path.join(root, 'synthetic-project');
const projectId = project.replace(/[^a-zA-Z0-9]/g, '-');
const sessions = { A: randomUUID(), B: randomUUID() };
const directories = { A: path.join(project, 'a'), B: path.join(project, 'b') };
const mentions = { A: path.join(directories.A, 'mentioned.txt'), B: path.join(directories.B, 'mentioned.txt') };
const evidence: Record<string, unknown> = {
  started: new Date().toISOString(), node: process.versions.node, repo, output, scenarios,
  isolation: { root, claude, project, projectId, sessions, userData: path.join(root, 'user-data') },
  boundary: 'actual Electron desktop dev window / contextBridge preload IPC / synthetic JSONL and files',
  cases: [],
};
let cdp: Cdp | undefined;
let owner: Awaited<ReturnType<typeof processIdentity>> = null;
let ownershipProbe: Promise<Awaited<ReturnType<typeof processIdentity>>> | undefined;
let launchLog: Buffer = Buffer.alloc(0);
let launchLogDroppedBytes = 0;
let eventsDropped = 0;
let rendererErrorCount = 0;
const rendererErrors: Cdp['events'] = [];
let signal: string | null = null;
const interrupted = (received: NodeJS.Signals) => { signal = received; };
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);

function appendLog(chunk: Buffer) {
  const combined = Buffer.concat([launchLog, chunk]);
  const excess = Math.max(0, combined.length - 1_048_576);
  launchLogDroppedBytes += excess;
  launchLog = combined.subarray(excess);
}
function isRendererError(event: Cdp['events'][number]) {
  return event.method === 'Runtime.exceptionThrown' ||
    (event.method === 'Runtime.consoleAPICalled' && (event.params as { type?: string })?.type === 'error') ||
    (event.method === 'Log.entryAdded' && (event.params as { entry?: { level?: string } })?.entry?.level === 'error');
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function evaluate<T>(expression: string) {
  assert(!signal, `Interrupted by ${signal}`);
  assert(cdp, 'Desktop CDP must be connected');
  const result = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description: string } } }>('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function call<T = unknown>(action: string, input: RendererInput) {
  return evaluate<T>(`(${renderer.toString()})(${JSON.stringify(action)}, ${JSON.stringify(input)})`);
}
async function fixture() {
  await mkdir(path.join(claude, 'projects', projectId), { recursive: true });
  await writeFile(path.join(claude, 'agent-teams-config.json'), JSON.stringify({
    general: { appLocale: 'en', theme: 'dark', defaultTab: 'dashboard', autoExpandAIGroups: true },
    notifications: { enabled: false, soundEnabled: false },
  }));
  await writeFile(path.join(claude, 'CLAUDE.md'), 'Synthetic global memory. Use only disposable E2E fixtures.\n');
  await mkdir(project);
  await writeFile(path.join(project, 'CLAUDE.md'), 'Synthetic project memory. Session identity must remain isolated.\n');
  for (const key of ['A', 'B'] as const) {
    await mkdir(directories[key]);
    await writeFile(path.join(directories[key], 'CLAUDE.md'), `Synthetic directory ${key} instructions with measured token data.\n`);
    await writeFile(mentions[key], `Synthetic mentioned ${key} file content used by actual preload file reads.\n`);
    const readPath = path.join(directories[key], 'read.txt');
    await writeFile(readPath, `Synthetic Read tool result ${key}.\n`);
    const id = sessions[key];
    const base = { sessionId: id, cwd: project, isSidechain: false, version: '2.1.0' };
    const user = randomUUID(), assistant = randomUUID(), result = randomUUID();
    const message = (uuid: string, parentUuid: string | null, type: string, content: unknown, index: number, extra = {}) => ({
      ...base, uuid, parentUuid, type, timestamp: new Date(Date.now() - 60_000 + index * 1000).toISOString(),
      message: { role: type, content, ...extra }, isMeta: type === 'user' && index === 2,
    });
    const usage = { input_tokens: 700, output_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };
    const records = [
      message(user, null, 'user', `Synthetic session ${key}: inspect @${mentions[key]}`, 0),
      message(assistant, user, 'assistant', [{ type: 'tool_use', id: `read-${key}`, name: 'Read', input: { file_path: readPath } }], 1, { id: `msg-read-${key}`, model: 'claude-sonnet-4-5', usage, stop_reason: 'tool_use' }),
      message(result, assistant, 'user', [{ type: 'tool_result', tool_use_id: `read-${key}`, content: `Synthetic Read tool result ${key}.` }], 2),
      message(randomUUID(), result, 'assistant', [{ type: 'text', text: `SENTRY_E2E_RESPONSE_${key}` }], 3, { id: `msg-end-${key}`, model: 'claude-sonnet-4-5', usage, stop_reason: 'end_turn' }),
    ];
    await writeFile(path.join(claude, 'projects', projectId, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
}
function assertLoaded(snapshot: Snapshot, session: string, directory: string, mentioned: string) {
  assert.equal(snapshot.tab.session, session);
  assert(snapshot.tab.chunks > 0, 'Actual JSONL must produce nonempty chunks');
  assert.equal(snapshot.tab.loading, false);
  assert.equal(snapshot.tab.conversationLoading, false);
  assert.equal(snapshot.tab.error, null);
  assert(snapshot.tab.claudeStats > 0 && snapshot.tab.contextStats > 0, 'Real session must produce nonempty stats Maps');
  assert(snapshot.tab.claudeInjections.some(injection => injection.source === 'directory' && injection.path === path.join(directory, 'CLAUDE.md') && injection.estimatedTokens > 0), 'Directory IPC must contribute measured tokens');
  assert(snapshot.tab.contextInjections.some(injection => injection.category === 'mentioned-file' && injection.path === mentioned && injection.exists && injection.estimatedTokens > 0), 'Mentioned-file IPC must contribute measured tokens');
}
function assertActiveB(snapshot: Snapshot, tabB: string) {
  assert.equal(snapshot.active, tabB);
  assert.equal(snapshot.selected, sessions.B);
  assert.equal(snapshot.project, projectId);
  assert.equal(snapshot.global.session, sessions.B);
  assert.equal(snapshot.global.loading, false);
  assert.equal(snapshot.global.conversationLoading, false);
  assert.equal(snapshot.global.error, null);
  assert(snapshot.visibleText.includes('SENTRY_E2E_RESPONSE_B'), 'Active session B response must be visible');
  assert(!snapshot.visibleText.includes('SENTRY_E2E_RESPONSE_A'), 'Inactive session A response must remain hidden');
  assert.equal(snapshot.selectedTabs.length, 1, 'Exactly one tab must be visibly selected');
  assert(snapshot.selectedTabs[0]?.includes('Synthetic session B'), 'Selected UI tab must be B');
}

try {
  await fixture();
  const port = await freePort();
  evidence.port = port;
  // Same desktop dev entry point as dev:mcp, with prepared hosted dependencies.
  // Avoid bootstrap installers/downloads and never start any provider runtime.
  const args = ['node_modules/electron-vite/bin/electron-vite.js', 'dev', '--remoteDebuggingPort', String(port), '--noSandbox'];
  evidence.launch = { command: process.execPath, args };
  const child = spawn(process.execPath, args, {
    cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NODE_ENV: 'development',
      AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
      AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(root, 'user-data'),
      AGENT_TEAMS_ORG_DEMO: '0', ELECTRON_RUN_AS_NODE: '',
    },
  });
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  let spawnError: Error | null = null;
  child.once('error', error => { spawnError = error; });
  const checkChild = () => {
    assert(!signal, `Interrupted by ${signal}`);
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Desktop exited: ${launchLog.slice(-6000)}`);
  };
  // Capture birth identity before checking interruption. A signal arriving just
  // after spawn must still leave enough ownership proof to clean up the group.
  assert(child.pid, 'Desktop launcher did not create a PID');
  ownershipProbe = processIdentity(child.pid);
  owner = await ownershipProbe;
  assert(owner, 'Desktop launcher exited before ownership capture');
  assert.equal(owner.group, owner.pid);
  evidence.owner = owner;
  await waitFor(async () => { checkChild(); return launchLog.includes(`DevTools listening on ws://127.0.0.1:${port}/`) ? true : null; }, 'isolated desktop CDP port', 180_000);
  const target = await waitFor(async () => {
    checkChild();
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
      return targets.find(item => item.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):/.test(item.url)) ?? null;
    } catch { return null; }
  }, 'owned desktop renderer');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const events = cdp.events, originalPush = events.push;
  events.push = (...items) => {
    for (const item of items) if (isRendererError(item)) {
      rendererErrorCount++;
      if (rendererErrors.length < 20) rendererErrors.push(item);
    }
    originalPush.apply(events, items);
    const excess = Math.max(0, events.length - 2000);
    if (excess) { events.splice(0, excess); eventsDropped += excess; }
    return events.length;
  };
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  const input: RendererInput = { project: projectId, session: sessions.A, directory: directories.A, mentioned: mentions.A, boundary: 'getSessionDetail' };
  await waitFor(async () => await call<boolean>('ready', input) || null, 'actual Electron preload and dev store');
  evidence.native = await captureNativeWindow(owner, output);
  for (const scenario of scenarios) for (const boundary of ['getSessionDetail', 'readDirectoryClaudeMd', 'readMentionedFile'] as const) {
    input.boundary = boundary;
    await call('reset', input);
    await call('install', input);
    try {
      const tabA = await call<string>('open', input);
      const held = await waitFor(async () => {
        const snapshot = await call<Snapshot>('snapshot', { ...input, tab: tabA });
        return snapshot.gate?.waiting ? snapshot : null;
      }, `${boundary}: A actual IPC response held`);
      assert.equal(held.tab.loading, true);
      const caseEvidence: Record<string, unknown> = { scenario, boundary, tabA, held };
      (evidence.cases as unknown[]).push(caseEvidence);
      const tabB = await call<string>(scenario === 'aba' ? 'replace' : 'open', { ...input, session: sessions.B });
      caseEvidence.tabB = tabB;
      assert.equal(tabB === tabA, scenario === 'aba', 'ABA must reuse the active tab ID; cache scenario must keep separate IDs');
      const before = await waitFor(async () => {
        const snapshot = await call<Snapshot>('snapshot', { ...input, tab: tabB });
        return snapshot.tab.session === sessions.B && snapshot.visibleText.includes('SENTRY_E2E_RESPONSE_B') ? snapshot : null;
      }, `${boundary}: B completes while A remains held`);
      caseEvidence.before = before;
      assertLoaded(before, sessions.B, directories.B, mentions.B);
      assertActiveB(before, tabB);
      assert.equal(before.tabs.length, scenario === 'aba' ? 1 : 2);
      assert((before.gate?.waiting ?? 0) > 0);
      await call('release', input);
      await waitFor(async () => await call<boolean>('settled', input) || null, `${scenario}/${boundary}: all held request IPC continuations settle`);
      const after = await call<Snapshot>('snapshot', { ...input, tab: tabA });
      caseEvidence.after = after;
      const png = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(output, `${scenario}-${boundary}.png`), Buffer.from(png.data, 'base64'));
      if (scenario === 'aba') {
        assertLoaded(after, sessions.B, directories.B, mentions.B);
        assert.deepEqual(after.tab, before.tab, 'Late A must not overwrite the reused tab B cache');
        assert.equal(after.tabs.find(tab => tab.id === tabB)?.session, sessions.B);
      } else assertLoaded(after, sessions.A, directories.A, mentions.A);
      assertActiveB(after, tabB);
      assert.deepEqual(after.global, before.global, 'Late A must not replace any global B state');
      caseEvidence.status = 'passed';
      process.stdout.write(`PASS ${scenario}/${boundary}: ${scenario === 'aba' ? 'late A cannot overwrite reused B cache' : 'late A fills only A cache'}\n`);
    } finally { await call('restore', input); }
  }
  assert.equal(rendererErrorCount, 0, `Renderer emitted errors: ${JSON.stringify(rendererErrors)}`);
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (cdp) {
    await cdp.evaluate("(() => { const gate = window.__sentryIdentityGate; if (gate) { gate.release(); Reflect.get = gate.originalGet; delete window.__sentryIdentityGate; } })()").catch(error => { evidence.restoreFailure = String(error); process.exitCode = 1; });
    evidence.events = cdp.events;
    cdp.close();
  }
  try {
    // Reuse the original birth probe if interruption prevented assignment.
    if (!owner && ownershipProbe) owner = await ownershipProbe;
    if (owner) evidence.cleanup = await stopOwnedGroup(owner);
    const fresh = await stat(root);
    assert.equal(fresh.dev, rootIdentity.dev); assert.equal(fresh.ino, rootIdentity.ino);
    await rm(root, { recursive: true, force: false });
    evidence.fixtureRemoved = true;
  } catch (error) { evidence.cleanupFailure = String(error); process.exitCode = 1; }
  await writeFile(path.join(output, 'desktop.log'), launchLog);
  evidence.logCapture = { retainedBytes: launchLog.length, droppedBytes: launchLogDroppedBytes, limitBytes: 1_048_576 };
  evidence.eventCapture = { dropped: eventsDropped, limit: 2000 };
  evidence.rendererErrors = rendererErrors;
  evidence.rendererErrorCount = rendererErrorCount;
  const files = ['scripts/e2e/sentry-tab-identity/run.mts', 'scripts/e2e/sentry-tab-identity/renderer.mts', 'scripts/tsconfig/tsconfig.sentry-e2e.json', 'scripts/tsconfig/e2e-base.json', 'src/renderer/store/slices/tabSlice.ts', 'src/renderer/store/slices/sessionDetailSlice.ts', 'src/renderer/store/session/sessionRequestIdentity.ts'];
  evidence.sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex')])));
  evidence.finished = new Date().toISOString();
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  process.stdout.write(`Desktop tab identity evidence: ${path.join(output, 'evidence.json')}\n`);
  if (process.exitCode) process.stderr.write(`${String(evidence.failure ?? evidence.cleanupFailure ?? evidence.restoreFailure)}\n`);
}
