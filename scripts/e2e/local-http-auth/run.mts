// Linux desktop qualification, using only an owned home, display and synthetic project.
// The dev launcher performs the normal checksum-pinned runtime/terminal bootstrap.
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Cdp, modulePaths, qualify } from './qualify.mts';

const checkout = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const cdpOrigin = 'http://127.0.0.1:9222';
const rendererOrigin = 'http://localhost:5173';
const browserCdpOrigin = 'http://127.0.0.1:9223';
const artifactDir = path.join(checkout, 'artifacts', 'local-http-auth-desktop');
let phase = 'preflight';
let runRoot = '';
let app: ChildProcess | undefined;
let browser: ChildProcess | undefined;
let browserObserved = false;
let browserClosed = false;
let chromePath = '';
let chromeLauncherPath = '';
let chromeBinaryObserved = false;
let failureCode: string | null = null;
let failureFrame: string | null = null;
const chromeFileFacts: Record<
  string,
  { uid: number; mode: string; file: boolean; symlink: boolean }
> = {};
let chromeVersion = '';
let display: ChildProcess | undefined;
let succeeded = false;
let appClosed = false;
let rendererObserved = false;
let displayStopped = false;
let displayNumber = '';
const pidHandles: Record<string, number> = {};
const diagnostics: string[] = [];
const sourceHashes: Record<string, string> = {};
const isLive = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null && !child.killed;
async function waitUntil(test: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await test()) return;
    await pause(200);
  } while (Date.now() < deadline);
  throw new Error('Observation deadline');
}
async function available(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Required local port already in use')));
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
}
function observe(child: ChildProcess, role: string): void {
  assert(child.pid, 'Child spawn failed');
  pidHandles[role] = child.pid;
  child.on('error', () => diagnostics.push(`${role}:spawn-error`));
  // Deliberately do not retain raw app/runtime output, network frames, headers or keys.
  const classify = (chunk: Buffer): void => {
    const value = chunk.toString('utf8');
    for (const [code, pattern] of [
      [
        'sandbox-initialization-failed',
        /No usable sandbox|SUID sandbox helper|Failed to move to new namespace/,
      ],
      ['native-module-abi-mismatch', /NODE_MODULE_VERSION|was compiled against a different Node/],
      ['vite-dependency-optimization', /new dependencies optimized|optimized dependencies changed/],
      ['vite-stale-prebundle', /Outdated Optimize Dep|outdated optimized deps/],
      ['vite-transform-or-resolution-failed', /Pre-transform error|Failed to resolve import/],
      [
        'runtime-download-failed',
        /pinned public runtime asset is unavailable|Runtime archive checksum/,
      ],
    ] as const)
      if (pattern.test(value) && !diagnostics.includes(code)) diagnostics.push(code);
  };
  child.stdout?.on('data', classify);
  child.stderr?.on('data', classify);
  child.on('exit', (code, signal) =>
    diagnostics.push(`${role}:exit:${code ?? signal ?? 'unknown'}`)
  );
}
async function ownedRendererSocket(): Promise<string | null> {
  const response = await fetch(`${cdpOrigin}/json/list`, {
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
  });
  const targets: unknown = await response.json();
  assert(Array.isArray(targets));
  const matches = targets.filter(
    (target: unknown) =>
      record(target) &&
      target.type === 'page' &&
      typeof target.url === 'string' &&
      target.url.startsWith(rendererOrigin + '/')
  );
  if (matches.length === 0) return null;
  assert.equal(matches.length, 1, 'Ambiguous renderer');
  const target: unknown = matches[0];
  assert(record(target) && typeof target.webSocketDebuggerUrl === 'string');
  const socket = new URL(target.webSocketDebuggerUrl);
  assert(
    socket.protocol === 'ws:' &&
      socket.hostname === '127.0.0.1' &&
      socket.port === '9222' &&
      !socket.username &&
      !socket.password &&
      !socket.search &&
      !socket.hash
  );
  return target.webSocketDebuggerUrl;
}
async function closeApp(): Promise<boolean> {
  if (!app || !isLive(app)) return app?.exitCode === 0;
  // Port was empty before our one launch. Never attach on cleanup without first
  // having observed this exact renderer after that launch.
  if (!rendererObserved) return false;
  let cdp: Cdp | undefined;
  try {
    const socket = await ownedRendererSocket();
    if (socket) {
      cdp = await Cdp.connect(socket, 'http://127.0.0.1');
      await cdp.inspect('window.electronAPI.windowControls.close()').catch(() => undefined);
    }
    await waitUntil(async () => !!app && !isLive(app), 30_000);
    return app.exitCode === 0;
  } catch {
    return false;
  } finally {
    cdp?.close();
  }
}
async function ownedBrowserSocket(): Promise<string> {
  const response = await fetch(`${browserCdpOrigin}/json/version`, {
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
  });
  const version: unknown = await response.json();
  assert(
    record(version) &&
      typeof version.webSocketDebuggerUrl === 'string' &&
      typeof version.Browser === 'string'
  );
  const expectedVersion = chromeVersion.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  assert(
    expectedVersion &&
      (version.Browser === 'Chrome/' + expectedVersion ||
        version.Browser === 'HeadlessChrome/' + expectedVersion),
    'Physical Chrome version differs from installed executable'
  );
  const socket = new URL(version.webSocketDebuggerUrl);
  assert(
    socket.protocol === 'ws:' &&
      socket.hostname === '127.0.0.1' &&
      socket.port === '9223' &&
      socket.pathname.startsWith('/devtools/browser/') &&
      !socket.username &&
      !socket.password &&
      !socket.search &&
      !socket.hash
  );
  return version.webSocketDebuggerUrl;
}
async function closeBrowser(): Promise<boolean> {
  if (!browser || !isLive(browser)) return !browser || browser.exitCode === 0;
  if (!browserObserved) return false;
  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.connect(await ownedBrowserSocket(), 'http://127.0.0.1');
    await cdp.send('Browser.close').catch(() => undefined);
    await waitUntil(async () => !!browser && !isLive(browser), 15_000);
    return browser.exitCode === 0;
  } catch {
    return false;
  } finally {
    cdp?.close();
  }
}
try {
  assert.equal(process.platform, 'linux', 'Use the Linux desktop runner');
  assert.notEqual(process.getuid?.(), 0, 'Electron must run as an unprivileged user');
  assert.equal(execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(), '11.22.0');
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: checkout,
      encoding: 'utf8',
    }).trim(),
    '',
    'Tracked checkout must be clean'
  );
  assert(
    !Object.values(process.env).some((value) => value?.includes('--no-sandbox')),
    'Do not disable Chromium sandbox'
  );
  await available(9222);
  await available(9223);
  await available(5173);
  const electronRoot = path.dirname(fileURLToPath(import.meta.resolve('electron/package.json')));
  const sandbox = await lstat(path.join(electronRoot, 'dist', 'chrome-sandbox'));
  assert(
    sandbox.isFile() &&
      !sandbox.isSymbolicLink() &&
      sandbox.uid === 0 &&
      (sandbox.mode & 0o7777) === 0o4755,
    'Use Electron setuid sandbox'
  );
  await access(path.join(electronRoot, 'dist', 'electron'));
  // GitHub's Ubuntu image supplies Chrome. Use its canonical native executable,
  // never a downloaded browser or an existing user profile/session.
  phase = 'chrome-resolve-launcher';
  chromeLauncherPath = await realpath(
    execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim()
  );
  phase = 'chrome-resolve-binary';
  chromePath = await realpath(path.join(path.dirname(chromeLauncherPath), 'chrome'));
  phase = 'chrome-binary-stat';
  const chromeBinary = await lstat(chromePath);
  chromeFileFacts.binary = {
    uid: chromeBinary.uid,
    mode: (chromeBinary.mode & 0o7777).toString(8),
    file: chromeBinary.isFile(),
    symlink: chromeBinary.isSymbolicLink(),
  };
  phase = 'chrome-sandbox-stat';
  const chromeSandbox = await lstat(path.join(path.dirname(chromePath), 'chrome-sandbox'));
  chromeFileFacts.sandbox = {
    uid: chromeSandbox.uid,
    mode: (chromeSandbox.mode & 0o7777).toString(8),
    file: chromeSandbox.isFile(),
    symlink: chromeSandbox.isSymbolicLink(),
  };
  phase = 'chrome-binary-ownership';
  assert(
    chromeBinary.isFile() && chromeBinary.uid === 0 && !(chromeBinary.mode & 0o022),
    'Installed Chrome binary is not root controlled'
  );
  phase = 'chrome-sandbox-ownership';
  assert(
    chromeSandbox.isFile() && chromeSandbox.uid === 0 && (chromeSandbox.mode & 0o7777) === 0o4755,
    'Installed Chrome sandbox is not setuid'
  );
  phase = 'source-binding-preflight';
  for (const relative of modulePaths) {
    if (!relative.startsWith('dist-electron/'))
      sourceHashes[relative] = hash(await readFile(path.join(checkout, relative)));
  }
  runRoot = await realpath(
    await mkdtemp(path.join(await realpath(os.tmpdir()), 'local-http-auth-desktop-'))
  );
  const home = path.join(runRoot, 'home');
  const claudeRoot = path.join(home, '.claude');
  const userData = path.join(home, 'electron-user-data');
  const ownTmp = path.join(runRoot, 'tmp');
  for (const dir of [
    home,
    claudeRoot,
    userData,
    ownTmp,
    path.join(claudeRoot, 'projects'),
    path.join(claudeRoot, 'todos'),
    path.join(claudeRoot, 'teams'),
    path.join(claudeRoot, 'tasks'),
  ])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: 'C.UTF-8',
    CI: 'true',
    TMPDIR: ownTmp,
    SHELL: '/bin/sh',
    NODE_ENV: 'development',
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claudeRoot,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
    CLAUDE_CONFIG_DIR: claudeRoot,
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: path.join(home, 'runtime-cache'),
    CLAUDE_TERMINAL_PLATFORM_DOWNLOAD_ROOT: path.join(home, 'terminal-download'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(home, 'multimodel-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(home, 'multimodel-cache'),
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
    XDG_DATA_HOME: path.join(home, 'xdg-data'),
    XDG_CACHE_HOME: path.join(home, 'xdg-cache'),
    XDG_STATE_HOME: path.join(home, 'xdg-state'),
    XDG_RUNTIME_DIR: path.join(home, 'xdg-runtime'),
    AGENT_TEAMS_DISABLE_GPU: '1',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    NODE_BINARY: await realpath(process.execPath),
    CORS_ORIGIN: rendererOrigin,
  };
  for (const key of [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'CLAUDE_MULTIMODEL_DATA_HOME',
    'CLAUDE_MULTIMODEL_CACHE_HOME',
  ])
    await mkdir(env[key]!, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(claudeRoot, 'agent-teams-config.json'),
    JSON.stringify({
      general: {
        theme: 'dark',
        appLocale: 'en',
        agentLanguage: 'en',
        defaultTab: 'teams',
      },
      httpServer: { enabled: true, port: 3456 },
    }),
    { mode: 0o600, flag: 'wx' }
  );
  // The runner-image contract tests google-chrome, its supported launcher.
  // Preserve its CHROME_WRAPPER/channel environment instead of invoking the inner
  // binary directly. Even --version gets the owned synthetic HOME.
  phase = 'chrome-version';
  chromeVersion = execFileSync(chromeLauncherPath, ['--version'], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  }).trim();
  phase = 'chrome-version-contract';
  assert(
    /^Google Chrome(?: for Testing)? \d+\.\d+\.\d+\.\d+$/.test(chromeVersion),
    'Unexpected installed Chrome version'
  );
  phase = 'xvfb';
  display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  observe(display, 'xvfb');
  const displayPipe = display.stdio[3];
  assert(displayPipe && 'on' in displayPipe);
  displayPipe.on('data', (chunk: Buffer) => {
    displayNumber += chunk.toString('utf8');
  });
  await waitUntil(async () => /^\d+\n$/.test(displayNumber), 10_000);
  env.DISPLAY = `:${displayNumber.trim()}`;
  phase = 'desktop-launch';
  app = spawn('pnpm', ['dev:mcp'], {
    cwd: checkout,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  observe(app, 'dev-mcp');
  await waitUntil(async () => {
    assert(app && isLive(app), 'App exited before renderer');
    try {
      rendererObserved = !!(await ownedRendererSocket());
      return rendererObserved;
    } catch {
      return false;
    }
  }, 240_000);
  phase = 'private-authority';
  const storage: unknown = await import(pathToFileURL(path.join(checkout, modulePaths[0])).href);
  const discovery: unknown = await import(pathToFileURL(path.join(checkout, modulePaths[1])).href);
  const domain: unknown = await import(pathToFileURL(path.join(checkout, modulePaths[2])).href);
  assert(
    record(storage) &&
      typeof storage.readPrivateJson === 'function' &&
      typeof storage.validateProfileRoot === 'function'
  );
  assert(record(discovery) && typeof discovery.validateDiscoveryReference === 'function');
  assert(record(domain) && typeof domain.validateAuthority === 'function');
  await storage.validateProfileRoot(claudeRoot);
  const readPrivateJson = storage.readPrivateJson;
  const validateReference = discovery.validateDiscoveryReference;
  const validateAuthority = domain.validateAuthority;
  let httpOrigin = '';
  await waitUntil(async () => {
    try {
      const scope = createHash('sha256').update(claudeRoot).digest('hex');
      const reference: unknown = validateReference(
        await readPrivateJson(path.join(claudeRoot, 'team-control-api.json')),
        claudeRoot,
        scope
      );
      assert(record(reference) && typeof reference.descriptorPath === 'string');
      const authority: unknown = validateAuthority(
        await readPrivateJson(reference.descriptorPath),
        scope
      );
      assert(record(authority) && typeof authority.baseUrl === 'string');
      const endpoint = new URL(authority.baseUrl);
      assert(
        endpoint.protocol === 'http:' &&
          endpoint.hostname === '127.0.0.1' &&
          endpoint.origin === authority.baseUrl &&
          !endpoint.username &&
          !endpoint.password
      );
      httpOrigin = authority.baseUrl;
      return true;
    } catch {
      return false;
    }
  }, 90_000);
  phase = 'binding';
  for (const relative of modulePaths) {
    const current = hash(await readFile(path.join(checkout, relative)));
    if (sourceHashes[relative])
      assert.equal(current, sourceHashes[relative], 'Source changed during launch');
    else sourceHashes[relative] = current;
  }
  phase = 'owned-chrome-launch';
  const chromeProfile = path.join(home, 'chrome-profile');
  await mkdir(chromeProfile, { mode: 0o700 });
  browser = spawn(
    chromeLauncherPath,
    [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9223',
      '--user-data-dir=' + chromeProfile,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  observe(browser, 'chrome');
  await waitUntil(async () => {
    assert(browser && isLive(browser), 'Owned Chrome exited before CDP');
    try {
      await ownedBrowserSocket();
      assert(
        browser?.pid && (await realpath(`/proc/${browser.pid}/exe`)) === chromePath,
        'Owned Chrome process image differs from installed binary'
      );
      chromeBinaryObserved = true;
      browserObserved = true;
      return true;
    } catch {
      return false;
    }
  }, 30_000);
  const out = path.join(runRoot, 'evidence');
  phase = 'qualification';
  succeeded = await qualify({
    checkout,
    runRoot,
    claudeRoot,
    out,
    httpOrigin,
    rendererOrigin,
    cdpOrigin,
    browserCdpOrigin,
    sourceHashes,
  });
  phase = succeeded ? 'complete' : 'qualification';
  await mkdir(artifactDir, { recursive: true });
  for (const name of ['BEFORE.json', 'RESULT.json'])
    await copyFile(path.join(out, name), path.join(artifactDir, name));
} catch (error) {
  succeeded = false;
  const code =
    record(error) &&
    typeof error.code === 'string' &&
    ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ERR_ASSERTION', 'ETIMEDOUT', 'EADDRINUSE'].includes(
      error.code
    )
      ? error.code
      : 'OPERATION_FAILED';
  const status =
    record(error) && typeof error.status === 'number' && Number.isSafeInteger(error.status)
      ? ':exit=' + error.status
      : '';
  failureCode = phase + ':' + code + status;
  const frame =
    error instanceof Error
      ? error.stack?.match(/\/scripts\/e2e\/local-http-auth\/run\.mts:(\d+):(\d+)/)
      : null;
  failureFrame = frame ? 'run.mts:' + frame[1] + ':' + frame[2] : null;
} finally {
  browserClosed = await closeBrowser();
  appClosed = await closeApp();
  // Xvfb is a process created here, with its retained ChildProcess handle.
  // Never signal a discovered PID or a process group, and never use SIGKILL.
  if (
    display &&
    isLive(display) &&
    (!app || appClosed || !isLive(app)) &&
    (!browser || browserClosed || !isLive(browser))
  ) {
    display.kill('SIGTERM');
    try {
      await waitUntil(
        async () => !!display && (display.exitCode !== null || display.signalCode !== null),
        5000
      );
    } catch {
      /* Report incomplete cleanup. */
    }
  }
  displayStopped = !display || display.exitCode !== null || display.signalCode !== null;
  await mkdir(artifactDir, { recursive: true });
  const result = {
    status: succeeded && appClosed && browserClosed && displayStopped ? 'PASS' : 'FAIL',
    phase,
    failureCode,
    failureFrame,
    checkout,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkout,
      encoding: 'utf8',
    }).trim(),
    runRoot,
    sourceHashes,
    pidHandles,
    diagnostics,
    rendererObserved,
    browserObserved,
    browserClosed,
    chromePath,
    chromeLauncherPath,
    chromeBinaryObserved,
    chromeFileFacts,
    chromeVersion,
    appClosed,
    displayStopped,
    chromiumSandbox: 'setuid',
    providerOrTeamStarted: false,
    runtimeCapabilityQualification: false,
  };
  const receipt = await open(path.join(artifactDir, 'LAUNCH.json'), 'wx', 0o600);
  try {
    await receipt.writeFile(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await receipt.close();
  }
  process.stdout.write(
    `local-http-auth-desktop: ${result.status}; phase=${phase}; code=${failureCode ?? 'none'}; appClosed=${appClosed}; browserClosed=${browserClosed}; displayStopped=${displayStopped}\n`
  );
  if (result.status !== 'PASS') process.exitCode = 1;
}
