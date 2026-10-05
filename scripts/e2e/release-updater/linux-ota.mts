import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

import { Cdp, waitFor } from './cdp.mts';
import { hashFile, linuxFeedAssets, loadInputs, pins } from './inputs.mts';
import { captureNativeWindow, processIdentity, stopOwnedGroup } from './native-window.mts';
import { startOtaMirror } from './ota-mirror.mts';
import { ownedApps, proveInstalledApp } from './ota-process.mts';
import { transportHook } from './transport.mts';

import type { TransportState } from './transport.mts';
import type { App } from 'electron';

interface Event {
  type: string;
  version?: string;
  percent?: number;
  transferred?: number;
}
interface Observer {
  on(
    event: string,
    listener: (info: { version?: string; percent?: number; transferred?: number }) => void
  ): unknown;
}
interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
interface Pause {
  callFrames: { callFrameId: string }[];
}
type MirrorRequests = Awaited<ReturnType<typeof startOtaMirror>>['requests'];
function assertProviderRoutes(requests: MirrorRequests) {
  for (const route of [
    '/github/777genius/agent-teams-ai/releases.atom',
    '/github/777genius/agent-teams-ai/releases/latest',
    '/github/777genius/agent-teams-ai/releases/download/v2.17.2/latest-linux.yml',
  ])
    assert(
      requests.some(
        (request) =>
          request.path === route &&
          request.method === 'GET' &&
          request.session === 'electron-updater' &&
          request.status === 200
      ),
      `Missing genuine provider GET: ${route}`
    );
}
function assertDownloadRoutes(requests: MirrorRequests) {
  assertProviderRoutes(requests);
  const image = `/github/777genius/agent-teams-ai/releases/download/v2.17.2/${targetPin.name}`;
  assert(
    requests.some(
      (request) =>
        request.path === '/api/repos/777genius/agent-teams-ai/releases/tags/v2.17.2' &&
        request.method === 'GET' &&
        request.session === 'default' &&
        request.status === 200
    ),
    'Missing service release API GET'
  );
  assert(
    requests.some(
      (request) =>
        request.path === image &&
        request.method === 'HEAD' &&
        request.session === 'default' &&
        request.status === 200
    ),
    'Missing service AppImage HEAD'
  );
  assert(
    requests.some(
      (request) =>
        request.path === image &&
        request.method === 'GET' &&
        request.session === 'electron-updater' &&
        request.status === 200 &&
        request.transferred === targetPin.size
    ),
    'Missing complete genuine installer GET'
  );
}
const args = process.argv.slice(2);
function option(name: string) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  assert(index >= 0 && value, `Required ${name}`);
  return path.resolve(value);
}
function requiredPin(index: number) {
  const pin = pins[index];
  assert(pin, 'Independent predecessor and target pins required');
  return pin;
}
const priorPin = requiredPin(0);
const targetPin = requiredPin(1);
const targetFeed = linuxFeedAssets[0];
assert(targetFeed, 'Independent target feed pin required');
const input = option('--inputs');
const output = option('--evidence');
await mkdir(output, { recursive: true });
const evidence: Record<string, unknown> = {
  scope: 'Linux AppImage native OTA 2.17.1 -> 2.17.2',
  passed: false,
  automaticSuccessorProved: false,
  diagnosticRelaunch: false,
  startedAt: new Date().toISOString(),
};
const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-linux-ota-'));
const home = path.join(root, 'home');
const userData = path.join(root, 'user-data');
const claude = path.join(home, '.claude');
const install = path.join(root, 'install');
const oldImage = path.join(install, priorPin.name);
const newImage = path.join(install, targetPin.name);
const owners = new Map<number, NonNullable<Awaited<ReturnType<typeof processIdentity>>>>();
const spawned = new Map<number, ReturnType<typeof spawn>>();
let main: Cdp | undefined;
let renderer: Cdp | undefined;
let mirror: Awaited<ReturnType<typeof startOtaMirror>> | undefined;
let logError: Error | undefined;
const log = createWriteStream(path.join(output, 'desktop.log'));
log.on('error', (error) => {
  logError = error;
});
let minimumStart: string | undefined;
const execute = promisify(execFile);
const sandboxSamples: { stage: string; command: string[]; noSandbox: boolean }[] = [];

async function wrapperProvenance(stage: string, executable: string, command: string[]) {
  const appRun = path.join(path.dirname(executable), 'AppRun');
  const bytes = await readFile(appRun);
  const source = bytes.toString('utf8');
  const saved = path.join(output, `${stage}-AppRun.txt`);
  await writeFile(saved, bytes);
  const noSandbox = command.some((argument) => /^--no-sandbox(?:=|$)/.test(argument));
  sandboxSamples.push({ stage, command, noSandbox });
  evidence.sandboxEnabled = sandboxSamples.every((sample) => !sample.noSandbox);
  evidence.sandbox = {
    harnessRequestedNoSandbox: false,
    canonicalGatePassed: evidence.sandboxEnabled,
    samples: sandboxSamples,
    limitation: sandboxSamples.some((sample) => sample.noSandbox)
      ? 'Official AppRun supplied --no-sandbox; native installation facts do not pass the canonical sandbox gate'
      : undefined,
  };
  return {
    path: appRun,
    saved,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    relevantLines: source.split('\n').filter((line) => /unshare|NO_SANDBOX|no-sandbox/.test(line)),
  };
}

async function automaticDesktop(
  owner: NonNullable<Awaited<ReturnType<typeof processIdentity>>>,
  directory: string
) {
  const deadline = Date.now() + 45_000;
  const env = {
    PATH: '/usr/bin:/bin',
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    LC_ALL: 'C',
  };
  const run = (command: string, parameters: string[]) => {
    assert(Date.now() < deadline, 'Automatic desktop did not paint within 45 seconds');
    return execute(command, parameters, {
      env,
      timeout: Math.min(10_000, deadline - Date.now()),
      maxBuffer: 1_048_576,
    });
  };
  const native = await captureNativeWindow(owner, directory);
  const attempts: Record<string, unknown>[] = [];
  evidence.automaticDesktop = { ready: false, timeoutMs: 45_000, attempts };
  while (Date.now() < deadline) {
    const identity = await processIdentity(owner.pid);
    assert.equal(identity?.start, owner.start, 'Automatic desktop PID changed');
    assert.equal(identity?.group, owner.group, 'Automatic desktop group changed');
    const { stdout: property } = await run('/usr/bin/xprop', ['-id', native.id, '_NET_WM_PID']);
    assert.equal(
      Number(/=\s*(\d+)/.exec(property)?.[1]),
      native.identity.pid,
      'Native window owner changed'
    );
    const { stdout: info } = await run('/usr/bin/xwininfo', ['-id', native.id, '-stats']);
    assert(/Map State:\s*IsViewable/.test(info), 'Automatic native window is hidden');
    const name = `attempt-${String(attempts.length + 1).padStart(3, '0')}`;
    const screenshot = path.join(directory, `${name}.png`);
    await run('/usr/bin/import', ['-window', native.id, screenshot]);
    const { stdout, stderr } = await run('/usr/bin/tesseract', [
      screenshot,
      'stdout',
      '--psm',
      '11',
    ]);
    const ocr = path.join(directory, `${name}.ocr.txt`);
    await writeFile(ocr, stdout);
    await writeFile(path.join(directory, `${name}.ocr.stderr.txt`), stderr);
    const image = await hashFile(screenshot);
    const current = await processIdentity(owner.pid);
    assert.equal(current?.start, owner.start, 'Automatic desktop PID changed during capture');
    assert.equal(current?.group, owner.group);
    const ready =
      /Providers\s*&\s*plans/i.test(stdout) &&
      /\bTasks\b/.test(stdout) &&
      !/Preparing\s+workspace|splash/i.test(stdout);
    attempts.push({
      capturedAt: new Date().toISOString(),
      screenshot,
      sha256: image.sha256,
      ocr,
      ocrSha256: createHash('sha256').update(stdout).digest('hex'),
      stdout,
      stderr,
      ready,
    });
    if (ready) {
      assert(Date.now() <= deadline, 'Automatic desktop did not paint within 45 seconds');
      evidence.automaticDesktop = { ready: true, timeoutMs: 45_000, attempts };
      await copyFile(screenshot, native.screenshot);
      return { ...native, identity: current, property, info, sha256: image.sha256, ocr };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
    );
  }
  throw new Error(
    'Automatic desktop did not show Providers & plans and Tasks without Preparing workspace within 45 seconds'
  );
}

// Read-only listeners attach to the bundled singleton in its original CJS frame.
function observeOta(app: App, getUpdater: () => Observer) {
  const events: Event[] = [];
  (globalThis as typeof globalThis & { __TEST_nativeOta: Event[] }).__TEST_nativeOta = events;
  app.once('ready', () => {
    const updater = getUpdater();
    updater.on('download-progress', (info) =>
      events.push({ type: 'progress', percent: info.percent, transferred: info.transferred })
    );
    updater.on('update-downloaded', (info) =>
      events.push({ type: 'downloaded', version: info.version })
    );
    updater.on('update-not-available', (info) =>
      events.push({ type: 'not-available', version: info.version })
    );
  });
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}
async function getTargets(endpoint: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint}/json/list`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok ? ((await response.json()) as Target[]) : null;
  } catch {
    return null;
  }
}
async function launchIdentity(child: ReturnType<typeof spawn>, pid: number) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    const identity = await processIdentity(pid);
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (identity) {
      assert.equal(identity.group, pid, 'Launch must own its detached process group');
      assert(/^[1-9]\d*$/.test(identity.start), 'Missing kernel launch start identity');
      return identity;
    }
    // Only ENOENT returns null; permission and ownership failures propagate.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Cannot prove ownership of spawned PID ${pid}`);
}
async function launch(image: string, env: NodeJS.ProcessEnv, version: string) {
  assert(mirror);
  const inspectorPort = await port();
  const rendererPort = await port();
  const app = spawn(
    image,
    [
      `--inspect-brk=127.0.0.1:${inspectorPort}`,
      `--remote-debugging-port=${rendererPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--lang=en-US',
      `--user-data-dir=${userData}`,
    ],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  app.on('error', (error) => {
    evidence.launchError = String(error);
  });
  assert(app.pid);
  spawned.set(app.pid, app);
  // A new spawn cannot reuse proof from an earlier launch with the same PID.
  owners.delete(app.pid);
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => {
      log.write(chunk);
      process.stdout.write(chunk);
    });
  const identity = await launchIdentity(app, app.pid);
  owners.set(identity.pid, identity);
  minimumStart ??= identity.start;
  const inspector = await waitFor(async () => {
    if (app.exitCode !== null) throw new Error(`Official ${version} exited ${app.exitCode}`);
    return (await getTargets(inspectorPort))?.find((item) => item.webSocketDebuggerUrl) ?? null;
  }, `official ${version} main inspector`);
  main = await Cdp.connect(inspector.webSocketDebuggerUrl);
  await main.send('Debugger.enable');
  await main.send('Runtime.runIfWaitingForDebugger');
  const paused = await waitFor(
    () =>
      Promise.resolve(
        (main!.events.find((item) => item.method === 'Debugger.paused')?.params as
          | Pause
          | undefined) ?? null
      ),
    'original CJS entry'
  );
  const frame = paused.callFrames[0];
  assert(frame);
  const filename = await main.evaluate<string>('__filename', frame.callFrameId);
  assert(filename.endsWith('/resources/app.asar/dist-electron/main/index.cjs'));
  await main.evaluate(
    `(${transportHook.toString()})(require('electron'),()=>autoUpdater,${JSON.stringify(mirror.origin)},${JSON.stringify(mirror.paths)});(${observeOta.toString()})(require('electron').app,()=>autoUpdater)`,
    frame.callFrameId
  );
  await main.send('Debugger.resume');
  const state = await waitFor(async () => {
    const candidate = await transport();
    return candidate.roots ? candidate : null;
  }, 'real packaged roots and hooks');
  assert.equal(state.roots?.version, version);
  assert.equal(state.roots?.userData, userData);
  assert.equal(state.roots?.home, home);
  assert.equal(state.roots?.appImage, image);
  assert.equal(state.roots?.packaged, true);
  assert.equal(state.updater?.class, 'AppImageUpdater');
  assert.deepEqual(state.bound, ['default', 'electron-updater']);
  assert.equal(
    await readlink(`/proc/${app.pid}/ns/net`),
    await readlink('/proc/self/ns/net'),
    'Child must inherit isolated network namespace'
  );
  const page = await waitFor(
    async () =>
      (await getTargets(rendererPort))?.find(
        (item) => item.type === 'page' && item.url.startsWith('file:')
      ) ?? null,
    'real renderer'
  );
  renderer = await Cdp.connect(page.webSocketDebuggerUrl);
  await renderer.send('Page.enable');
  await waitFor(
    () =>
      renderer!.evaluate<boolean | null>(
        '!document.getElementById("splash") && document.readyState === "complete" ? true : null'
      ),
    'painted desktop'
  );
  const command = (await readFile(`/proc/${app.pid}/cmdline`)).toString().split('\0');
  assert(state.roots?.executable);
  const wrapper = await wrapperProvenance(`launch-${version}`, state.roots.executable, command);
  return { identity, state, filename, command, wrapper };
}
async function transport() {
  assert(main);
  const state = await main.evaluate<TransportState>('globalThis.__TEST_nativeUpdater');
  if (state?.error) throw new Error(state.error);
  return state;
}
async function otaEvents() {
  assert(main);
  return main.evaluate<Event[]>('globalThis.__TEST_nativeOta');
}
async function point(pattern: string, scope = 'document') {
  assert(renderer);
  return renderer.evaluate<{ x: number; y: number; text: string } | null>(`(() => {
    const root=${scope}; const button=[...(root?.querySelectorAll('button')??[])].find(b=>new RegExp(${JSON.stringify(pattern)},'i').test(b.textContent.trim()) && !b.disabled);
    if(!button || document.getElementById('splash')) return null;
    button.scrollIntoView({block:'center'}); const r=button.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
    return r.width && r.height && button.contains(document.elementFromPoint(x,y)) ? {x,y,text:button.textContent.trim()} : null;
  })()`);
}
async function click(pattern: string, scope?: string) {
  const location = await waitFor(() => point(pattern, scope), `actionable ${pattern}`);
  assert(renderer);
  for (const type of ['mousePressed', 'mouseReleased'])
    await renderer.send('Input.dispatchMouseEvent', {
      type,
      x: location.x,
      y: location.y,
      button: 'left',
      clickCount: 1,
    });
  return location;
}
async function screenshot(name: string) {
  assert(renderer);
  const image = await renderer.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(image.data, 'base64'));
}
async function uiSnapshot() {
  assert(renderer);
  return renderer.evaluate(
    `({ url:location.href, body:document.body.innerText.slice(0,30000), dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.textContent), buttons:[...document.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent?.trim(),disabled:e.disabled,visible:Boolean(r.width&&r.height),x:r.x,y:r.y}}) })`
  );
}
async function config() {
  return JSON.parse(await readFile(path.join(claude, 'agent-teams-config.json'), 'utf8')) as {
    general: { theme: string };
  };
}

try {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert(process.getuid?.() !== 0, 'No root GUI or disabled sandbox');
  assert(process.env.DISPLAY && process.env.XAUTHORITY, 'Private Xvfb required');
  const interfaces = os.networkInterfaces();
  assert.deepEqual(
    Object.keys(interfaces),
    ['lo'],
    'Run parent mirror and app in a loopback-only disposable network namespace'
  );
  assert(
    Object.values(interfaces)
      .flat()
      .every((address) => address?.internal)
  );
  evidence.networkNamespace = await readlink('/proc/self/ns/net');
  evidence.unshareProbe = await execute('/usr/bin/unshare', ['-Ur', 'true'], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 5000,
  }).then(
    (result) => ({ supported: true, ...result }),
    (error: unknown) => {
      const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
      return {
        supported: false,
        code: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
      };
    }
  );
  evidence.apparmorRestrictUnprivilegedUserns = await readFile(
    '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    'utf8'
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  await access('/dev/fuse');
  const inputs = await loadInputs(input);
  const feed = args.includes('--staged-feed')
    ? await readFile(option('--staged-feed'), 'utf8')
    : inputs.feed;
  const metadata = parse(feed) as {
    version: string;
    path: string;
    sha512: string;
    files: { url: string; size: number; sha512: string }[];
  };
  assert.equal(metadata.version, '2.17.2');
  assert.equal(metadata.path, targetPin.name);
  assert.equal(metadata.sha512, targetFeed.sha512);
  assert.equal(metadata.files.length, linuxFeedAssets.length);
  for (const item of linuxFeedAssets) {
    const matches = metadata.files.filter((file) => file.url === item.name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.sha512, item.sha512);
    assert.equal(matches[0]?.size, item.size);
  }
  evidence.inputs = inputs.verified;
  evidence.inputDigest = inputs.inputDigest;
  evidence.feed = {
    source: args.includes('--staged-feed')
      ? option('--staged-feed')
      : 'feasibility-publication-preview',
    sha256: createHash('sha256').update(feed).digest('hex'),
    finalPromotionFeed: false,
    planBindingVerified: false,
    inputKind: args.includes('--staged-feed')
      ? 'operator-provided-unbound-feed'
      : 'feasibility-publication-preview',
  };
  await writeFile(path.join(output, 'latest-linux.yml'), feed);
  for (const directory of [
    install,
    home,
    userData,
    claude,
    path.join(root, 'tmp'),
    path.join(home, '.config'),
    path.join(home, '.cache'),
    path.join(home, '.local/share'),
  ])
    await mkdir(directory, { recursive: true });
  await copyFile(path.join(input, 'old.AppImage'), oldImage);
  await chmod(oldImage, 0o755);
  assert.equal((await hashFile(oldImage)).sha256, priorPin.sha256);
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'production',
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: path.join(home, '.codex'),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
  };
  evidence.isolation = {
    root,
    home,
    userData,
    claude,
    install,
    childEnvironmentKeys: Object.keys(env),
  };
  mirror = await startOtaMirror(inputs, input, feed);
  evidence.prior = await launch(oldImage, env, '2.17.1');
  await waitFor(async () => {
    const state = await transport();
    return state.updater?.provider === 'GitHubProvider' &&
      state.events.some((event) => event.type === 'available' && event.version === '2.17.2')
      ? true
      : null;
  }, 'genuine available version');
  // The bundled updater event precedes asynchronous service HEAD/API validation.
  // Wait for its real renderer result before navigating to Settings.
  await waitFor(
    () =>
      renderer!.evaluate<boolean | null>(
        'document.body.innerText.includes("2.17.2") ? true : null'
      ),
    'validated update reaches normal UI'
  );
  evidence.beforeSettingsUi = await uiSnapshot();
  if (await point('^Later$', 'document.querySelector("[role=dialog]")'))
    await click('^Later$', 'document.querySelector("[role=dialog]")');
  await waitFor(
    () =>
      renderer!.evaluate<boolean | null>('document.querySelector("[role=dialog]") ? null : true'),
    'update dialog closed before Settings'
  );
  assert(renderer);
  for (const type of ['keyDown', 'keyUp'])
    await renderer.send('Input.dispatchKeyEvent', { type, key: ',', code: 'Comma', modifiers: 2 });
  evidence.afterSettingsShortcutUi = await uiSnapshot();
  await click('^Light$');
  await waitFor(async () => {
    try {
      return (await config()).general.theme === 'light' ? true : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }, 'TEST preference persisted through real Settings UI');
  evidence.profileBefore = await config();
  await screenshot('profile-before');
  await click('^Advanced$');
  const availableBeforeCheck = (await transport()).events.filter(
    (event) => event.type === 'available'
  ).length;
  await click('^(?:Check for updates|v?2\\.17\\.2 available)$');
  await waitFor(
    async () =>
      (await transport()).events.filter((event) => event.type === 'available').length >
      availableBeforeCheck
        ? true
        : null,
    'user Check reaches genuine updater'
  );
  if (!(await point('^Download$', 'document.querySelector("[role=dialog]")')))
    await click('^(?:Update app|View details)$');
  await waitFor(
    () => point('^Download$', 'document.querySelector("[role=dialog]")'),
    'available dialog'
  );
  await screenshot('available');
  evidence.downloadAction = await click('^Download$', 'document.querySelector("[role=dialog]")');
  await waitFor(
    async () =>
      (await otaEvents()).some(
        (event) =>
          event.type === 'progress' && (event.percent ?? 0) > 0 && (event.percent ?? 100) < 100
      )
        ? true
        : null,
    'genuine download progress',
    120_000
  );
  evidence.progressUi = await waitFor(
    () =>
      renderer!.evaluate<string | null>(
        `(() => { const button=[...document.querySelectorAll('button')].find(b=>/\\d+%/.test(b.textContent)); if(!button) return null; const r=button.getBoundingClientRect(); return r.width && r.height ? button.textContent.trim() : null; })()`
      ),
    'visible progress from real updater'
  );
  await screenshot('progress');
  await waitFor(
    async () =>
      (await otaEvents()).some((event) => event.type === 'downloaded' && event.version === '2.17.2')
        ? true
        : null,
    'genuine downloaded version',
    180_000
  );
  if (!(await point('^Restart now$', 'document.querySelector("[role=dialog]")')))
    await click('^(?:Restart to update|View details)$');
  await waitFor(
    () => point('^Restart now$', 'document.querySelector("[role=dialog]")'),
    'actionable downloaded dialog'
  );
  await screenshot('downloaded');
  evidence.updaterEvents = await otaEvents();
  evidence.transport = await transport();
  assertDownloadRoutes(mirror.requests);
  const downloadLog = await readFile(path.join(output, 'desktop.log'), 'utf8');
  evidence.downloadMode = {
    fullDownloadObserved: mirror.requests.some(
      (request) =>
        request.method === 'GET' &&
        request.path.endsWith('.AppImage') &&
        !request.range &&
        request.status === 200
    ),
    fullFallbackObserved: downloadLog.includes(
      'Cannot download differentially, fallback to full download'
    ),
    differentialProved: false,
    fallbackLog: downloadLog.split('\n').filter((line) => /differential|fallback/.test(line)),
  };
  const before = new Set(
    (await ownedApps({ root, home, userData }, minimumStart!)).map((app) => app.pid)
  );
  evidence.installAction = await click('^Restart now$', 'document.querySelector("[role=dialog]")');
  // Let the original updater quit without an attached debugger holding exit.
  main?.close();
  renderer?.close();
  main = undefined;
  renderer = undefined;
  const successor = await waitFor(
    async () =>
      (await ownedApps({ root, home, userData }, minimumStart!)).find(
        (app) => app.image === newImage && !before.has(app.pid)
      ) ?? null,
    'updater-created automatic successor',
    90_000
  );
  assert.equal(successor.group, successor.pid, 'Automatic successor must own its spawned group');
  owners.set(successor.pid, successor);
  assert.equal(await readlink(`/proc/${successor.pid}/ns/net`), evidence.networkNamespace);
  assert(
    !successor.command.some((argument) => /inspect|remote-debugging/.test(argument)),
    'Automatic updater restart must precede any diagnostic relaunch'
  );
  const installed = await hashFile(newImage);
  assert.equal(installed.sha256, targetPin.sha256);
  assert.equal(installed.sha512, targetFeed.sha512);
  assert.equal(installed.size, targetPin.size);
  assert((await stat(newImage)).mode & 0o111, 'Installed image must remain executable');
  assert.equal(
    await access(oldImage).then(
      () => true,
      () => false
    ),
    false,
    'Updater must replace its owned prior image'
  );
  evidence.successor = await proveInstalledApp(successor);
  evidence.automaticWrapper = await wrapperProvenance(
    'automatic-successor',
    successor.executable,
    successor.command
  );
  const nativeOutput = path.join(output, 'automatic-successor');
  await mkdir(nativeOutput);
  evidence.automaticWindow = await automaticDesktop(successor, nativeOutput);
  evidence.successor = await proveInstalledApp(successor);
  assert.equal((await config()).general.theme, 'light');
  evidence.profileAfterAutomatic = await config();
  evidence.automaticSuccessorProved = true;
  evidence.automaticProofAt = new Date().toISOString();
  // Diagnostic relaunch is permitted only after the automatic native proof.
  evidence.automaticStop = await stopOwnedGroup(successor);
  evidence.diagnosticRelaunch = true;
  const diagnosticRequestStart = mirror.requests.length;
  const downloadRequests = mirror.requests.filter(
    (request) => request.method === 'GET' && request.path.endsWith('.AppImage')
  ).length;
  evidence.diagnostic = await launch(newImage, env, '2.17.2');
  await waitFor(
    async () =>
      (await otaEvents()).some(
        (event) => event.type === 'not-available' && event.version === '2.17.2'
      )
        ? true
        : null,
    'new installed app genuine no-update'
  );
  assert.equal(
    await renderer!.evaluate<boolean>('document.documentElement.classList.contains("light")'),
    true,
    'Real new renderer must load preserved preference'
  );
  assert.equal((await config()).general.theme, 'light');
  assertProviderRoutes(mirror.requests.slice(diagnosticRequestStart));
  assert.equal(
    mirror.requests.filter(
      (request) => request.method === 'GET' && request.path.endsWith('.AppImage')
    ).length,
    downloadRequests
  );
  evidence.postUpdate = {
    events: await otaEvents(),
    transport: await transport(),
    preference: 'light',
    noInstallerGet: true,
  };
  await screenshot('post-update');
  assert(!logError);
  assert(
    sandboxSamples.every((sample) => !sample.noSandbox),
    'Official AppRun disabled the sandbox; canonical native OTA gate cannot pass on this host'
  );
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.lastTransport = await transport().catch(() => undefined);
  evidence.failureUi = await uiSnapshot().catch(() => undefined);
  await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  try {
    if (minimumStart) {
      for (const candidate of await ownedApps({ root, home, userData }, minimumStart))
        if (candidate.group === candidate.pid) owners.set(candidate.pid, candidate);
    }
  } catch (error) {
    evidence.discoveryCleanupError = String(error);
    evidence.passed = false;
    process.exitCode = 1;
  }
  const unresolved = [...spawned.entries()]
    .filter(([pid]) => !owners.has(pid))
    .map(([pid, child]) => {
      // Release our pipes and handle without signaling an unproven PID/group.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      return { pid, signalSent: false };
    });
  evidence.unresolvedLaunches = unresolved;
  if (unresolved.length) {
    evidence.cleanupError = 'Spawned launch ownership remains unresolved; no signals sent';
    evidence.passed = false;
    process.exitCode = 1;
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => main?.close()),
    Promise.resolve().then(() => renderer?.close()),
    ...[...owners.values()].map((owner) => stopOwnedGroup(owner)),
    mirror?.close(),
  ]);
  evidence.cleanup = cleanup.map((result) =>
    result.status === 'fulfilled' ? result.value : String(result.reason)
  );
  if (cleanup.some((result) => result.status === 'rejected') || logError) {
    evidence.passed = false;
    process.exitCode = 1;
  }
  await new Promise<void>((resolve) => {
    if (log.destroyed) resolve();
    else log.end(resolve);
  });
  evidence.requests = mirror?.requests;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)).catch(
    (error) => {
      process.stderr.write(`Evidence write failed after cleanup: ${String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
console.log(
  JSON.stringify({
    passed: evidence.passed,
    automaticSuccessorProved: evidence.automaticSuccessorProved,
    error: evidence.error,
    evidence: output,
  })
);
