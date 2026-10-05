import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { captureSources, readAsar, readInspectorFuse } from './archive.mts';
import { Cdp, waitFor } from './cdp.mts';
import { hashFile, loadInputs, pins } from './inputs.mts';
import { startMirror } from './mirror.mts';
import { captureNativeWindow, processIdentity, stopOwnedGroup } from './native-window.mts';
import { transportHook } from './transport.mts';

import type { TransportState } from './transport.mts';

interface Target { type: string; url: string; webSocketDebuggerUrl: string; }
interface Paused { callFrames: { callFrameId: string; url: string }[]; }
const args = process.argv.slice(2);
function option(name: string) { const index = args.indexOf(name); const value = args[index + 1]; assert(index >= 0 && value, `Required ${name}`); return path.resolve(value); }
const input = option('--inputs');
const executable = args.includes('--executable') ? option('--executable') : path.join(input, 'old.AppImage');
const output = option('--evidence');
await mkdir(output, { recursive: true });
const evidence: Record<string, unknown> = { scope: 'Linux official 2.17.1 AppImage availability only', feasibilityOnly: true, installAttempted: false, startedAt: new Date().toISOString(), passed: false };
const log = createWriteStream(path.join(output, 'desktop.log'));
let logError: Error | undefined;
log.on('error', error => { logError = error; });
let app: ReturnType<typeof spawn> | undefined;
let main: Cdp | undefined;
let renderer: Cdp | undefined;
let mirror: Awaited<ReturnType<typeof startMirror>> | undefined;
let launchError: Error | undefined;
let owner: Awaited<ReturnType<typeof processIdentity>> | undefined;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function targets(port: number) {
  if (launchError) throw launchError;
  if (app?.exitCode !== null && app?.exitCode !== undefined) throw new Error(`Official app exited ${app.exitCode}`);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() as Target[] : null;
  } catch { return null; }
}
async function transport() {
  assert(main);
  const state = await main.evaluate<TransportState | undefined>('globalThis.__TEST_nativeUpdater');
  if (state?.error) throw new Error(state.error);
  return state;
}
async function screenshot(name: string) {
  if (!renderer) return;
  const image = await renderer.send<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(image.data, 'base64'));
}

try {
  assert.equal(process.platform, 'linux', 'Run this native gate on a disposable Linux VM');
  assert.equal(process.arch, 'x64');
  assert(process.getuid?.() !== 0, 'Electron must run unprivileged with its sandbox enabled');
  assert(process.env.DISPLAY && process.env.XAUTHORITY, 'Private authenticated Xvfb is required');
  await access('/dev/fuse');
  const inputs = await loadInputs(input);
  const actualExecutable = await hashFile(executable);
  assert.equal(actualExecutable.sha256, pins[0]?.sha256, 'Only unmodified official predecessor may run');
  assert.equal(actualExecutable.size, pins[0]?.size);
  evidence.inputs = inputs.verified;
  evidence.inputDigest = inputs.inputDigest;
  await writeFile(path.join(output, 'feasibility-latest-linux.yml'), inputs.feed);
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-native-updater-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'user-data');
  const claude = path.join(home, '.claude');
  for (const directory of [home, userData, claude, path.join(root, 'tmp'), path.join(home, '.config'), path.join(home, '.cache'), path.join(home, '.local/share')]) await mkdir(directory, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NODE_ENV: 'production',
    DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
    HOME: home, USERPROFILE: home, TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(home, '.codex'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData, AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1', CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
  };
  evidence.isolation = { root, home, userData, claude, childEnvironmentKeys: Object.keys(env), authenticatedXvfb: true };
  mirror = await startMirror(inputs);
  const mainPort = await freePort();
  const rendererPort = await freePort();
  await chmod(executable, 0o755);
  app = spawn(executable, [`--inspect-brk=127.0.0.1:${mainPort}`, `--remote-debugging-port=${rendererPort}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userData}`, '--lang=en-US'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  app.on('error', error => { launchError = error; });
  if (app.pid) owner = await processIdentity(app.pid);
  for (const stream of [app.stdout, app.stderr]) stream?.on('data', (chunk: Buffer) => { log.write(chunk); process.stdout.write(chunk); });
  evidence.pid = app.pid;
  const inspector = await waitFor(async () => (await targets(mainPort))?.find(item => item.webSocketDebuggerUrl) ?? null, 'packaged main inspector (fuse/FUSE/sandbox gate)');
  main = await Cdp.connect(inspector.webSocketDebuggerUrl);
  await main.send('Debugger.enable');
  await main.send('Runtime.runIfWaitingForDebugger');
  const paused = await waitFor(() => {
    const event = main?.events.find(item => item.method === 'Debugger.paused');
    return Promise.resolve(event ? event.params as Paused : null);
  }, 'original CJS app-entry pause');
  evidence.initialPause = paused;
  const frame = paused.callFrames[0];
  assert(frame, 'Missing initial call frame');
  const entry = await main.evaluate<string>('__filename', frame.callFrameId);
  assert(entry.endsWith('/resources/app.asar/dist-electron/main/index.cjs'), 'Pause must identify actual ASAR main');
  evidence.entry = entry;
  assert(frame, 'Inspector did not pause in the official CJS app entry');
  evidence.pause = frame;
  evidence.hook = await main.evaluate(`(${transportHook.toString()})(require('electron'),()=>autoUpdater,${JSON.stringify(mirror.origin)},${JSON.stringify(mirror.paths)})`, frame.callFrameId);
  await main.send('Debugger.resume');
  const bound = await waitFor(async () => { const state = await transport(); return state?.roots ? state : null; }, 'early two-session hooks');
  assert.deepEqual(bound.bound, ['default', 'electron-updater']);
  assert.equal(bound.roots?.userData, userData);
  assert.equal(bound.roots?.home, home);
  assert.equal(bound.roots?.version, '2.17.1');
  assert.equal(bound.roots?.arch, 'x64');
  assert.equal(bound.roots?.packaged, true);
  assert.equal(await realpath(bound.roots?.appImage ?? ''), await realpath(executable), 'Real FUSE image must supply APPIMAGE');
  assert.equal(bound.updater?.class, 'AppImageUpdater');
  assert(bound.roots);
  evidence.fuse = await readInspectorFuse(bound.roots.executable);
  const asar = path.join(bound.roots.resources, 'app.asar');
  evidence.sources = await captureSources(asar, output);
  const packaged = JSON.parse((await readAsar(asar, ['package.json'])).get('package.json')!.toString()) as { version: string; main: string };
  assert.equal(packaged.version, '2.17.1');
  assert.equal(packaged.main, 'dist-electron/main/index.cjs');
  await writeFile(path.join(output, 'app-update.yml'), await readFile(path.join(bound.roots.resources, 'app-update.yml')));
  const page = await waitFor(async () => (await targets(rendererPort))?.find(item => item.type === 'page' && item.url.startsWith('file:')) ?? null, 'packaged renderer CDP');
  renderer = await Cdp.connect(page.webSocketDebuggerUrl);
  await renderer.send('Page.enable');
  await waitFor(() => renderer!.evaluate<boolean | null>('!document.getElementById("splash") && document.readyState === "complete" ? true : null'), 'painted desktop');
  const available = await waitFor(async () => { const state = await transport(); return state?.updater?.provider === 'GitHubProvider' && state.events.some(event => event.type === 'available' && event.version === '2.17.2') ? state : null; }, 'genuine GitHubProvider available 2.17.2');
  const details = await waitFor(() => renderer!.evaluate<{ x: number; y: number } | true | null>(`(() => {
    if(document.querySelector('[role=dialog]')) return true;
    const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='View details' && !b.disabled);
    if(!button || !button.parentElement.textContent.includes('2.17.2')) return null;
    const r=button.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;
    return r.width && r.height && button.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
  })()`), 'real 2.17.2 update banner');
  if (details !== true) {
    for (const type of ['mousePressed', 'mouseReleased']) await renderer.send('Input.dispatchMouseEvent', { type, ...details, button: 'left', clickCount: 1 });
  }
  const ui = await waitFor(() => renderer!.evaluate<string | null>(`(() => {
    const dialog=document.querySelector('[role=dialog]');
    const download=dialog && [...dialog.querySelectorAll('button')].find(b=>b.textContent.trim()==='Download' && !b.disabled);
    if(!dialog || !download || !dialog.textContent.includes('2.17.2')) return null;
    const r=download.getBoundingClientRect();
    return r.width && r.height && download.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)) ? dialog.textContent.trim() : null;
  })()`), 'normal UI available 2.17.2 with actionable Download');
  const required = [
    ['electron-updater', 'GET', '/releases.atom'], ['electron-updater', 'GET', '/releases/latest'],
    ['electron-updater', 'GET', '/latest-linux.yml'], ['default', 'GET', '/releases/tags/v2.17.2'],
    ['default', 'HEAD', '/Agent.Teams.AI-2.17.2.AppImage'],
  ] as const;
  for (const [session, method, suffix] of required) assert(mirror.requests.some(item => item.session === session && item.method === method && item.path.endsWith(suffix) && item.status === 200), `Effective ${session} listener: ${method} ${suffix}`);
  assert(!mirror.requests.some(item => item.method === 'GET' && item.path.endsWith('.AppImage')), 'Feasibility must not download/install');
  evidence.transport = available;
  evidence.ui = ui;
  await screenshot('available');
  assert(owner, 'Owned launch identity missing');
  evidence.nativeWindow = await captureNativeWindow(owner, output);
  assert(!logError, `Desktop evidence stream failed: ${String(logError)}`);
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.transport = await transport().catch(() => undefined);
  await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  // Evidence I/O and each resource cleanup have independent failure paths.
  try {
    const controls = await Promise.allSettled([
      Promise.resolve().then(() => main?.close()),
      Promise.resolve().then(() => renderer?.close()),
      owner ? stopOwnedGroup(owner) : Promise.resolve(null),
    ]);
    const termination = controls[2];
    evidence.cleanup = termination?.status === 'fulfilled' ? termination.value : undefined;
    const failures = controls.filter(result => result.status === 'rejected');
    if (failures.length) {
      evidence.cleanupError = failures.map(result => String(result.reason)).join('; ');
      evidence.passed = false;
      process.exitCode = 1;
    }
  } catch (error) {
    evidence.cleanupError = String(error);
    evidence.passed = false;
    process.exitCode = 1;
  } finally {
    const resources = await Promise.allSettled([
      mirror?.close(),
      new Promise<void>(resolve => { if (log.destroyed) resolve(); else log.end(resolve); }),
    ]);
    evidence.resourceCleanup = resources.map(result => result.status === 'rejected' ? String(result.reason) : 'closed');
    if (resources.some(result => result.status === 'rejected') || logError) { evidence.passed = false; process.exitCode = 1; }
    evidence.requests = mirror?.requests ?? [];
    evidence.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)).catch(error => {
      process.stderr.write(`Evidence write failed after cleanup: ${String(error)}\n`);
      evidence.passed = false;
      process.exitCode = 1;
    });
  }
}
console.log(JSON.stringify({ passed: evidence.passed, scope: evidence.scope, evidence: output, error: evidence.error }));
