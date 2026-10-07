import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { readAsar, readInspectorFuse } from './archive.mts';
import { Cdp, waitFor } from './cdp.mts';
import {
  cdpCallFunction,
  cdpSerializedFunction,
  cdpBodyContains,
  cdpButtonPoint,
} from './cdp-values.mts';
import { hashFile } from './inputs.mts';
import { transportHook } from './transport.mts';
import { readWindowsInputMode, windowsInputs } from './windows-mirror.mts';
import { assertCaptionProof, readPeArchitecture, windowsNative } from './windows-native.mts';
import {
  proveWindowsDownload,
  proveWindowsProvider,
  windowsOtaMirror,
} from './windows-ota-mirror.mts';
import { assertNativeNames, windowsOtaObserver } from './windows-ota-observer.mts';
import {
  absent,
  appEnvironment,
  ownPhysicalProfile,
  releasePhysicalProfile,
} from './windows-ota-profile.mts';
import { inheritedWindowsEnvironment } from './windows-powershell.mts';
import { prepareArmPriorFixture } from './windows-arm-prior-fixture.mts';

import type { App } from 'electron';
import type { ChildProcess } from 'node:child_process';
import type { TransportState } from './transport.mts';
import type { WindowsProcess } from './windows-native.mts';
import type { PhysicalProfile, ProfileOwnership } from './windows-ota-profile.mts';

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
interface Pause {
  callFrames: { callFrameId: string }[];
}
interface OtaEvent {
  type: string;
  version?: string;
  percent?: number;
  transferred?: number;
}
interface Updater {
  on(
    event: string,
    listener: (info: { version?: string; percent?: number; transferred?: number }) => void
  ): unknown;
  downloadedUpdateHelper: { cacheDir: string; file: string | null } | null;
  app: { baseCachePath: string };
  disableDifferentialDownload: boolean;
  previousBlockmapBaseUrlOverride: string | null;
  installDirectory: string | undefined;
}
interface OtaState {
  events: OtaEvent[];
  cache?: { base: string; directory?: string; file?: string | null };
  settings?: {
    differentialDisabled: boolean;
    blockmapOverride: string | null;
    installDirectory?: string;
  };
}
interface Ownership {
  root: string;
  executable: string;
  installers: string[];
  firewallGroup: string;
  firewallNames: string[];
  profileFile: string;
}
interface FreshReference {
  passed: boolean;
  arch: string;
  inputDigest: string;
  installerSha256: string;
  installed: {
    executable: Awaited<ReturnType<typeof hashFile>>;
    asar: Awaited<ReturnType<typeof hashFile>>;
    packageVersion: string;
    architecture: string;
    signature: Awaited<ReturnType<Awaited<ReturnType<typeof windowsNative>>['signature']>>;
  };
}

// Listeners/getters only: preserve the original singleton, provider, signature
// verifier, download algorithms, pending paths and quit/install implementations.
function observeOta(app: App, getUpdater: () => Updater) {
  const state: OtaState = { events: [] };
  const global = globalThis as typeof globalThis & {
    __TEST_windowsOta: OtaState;
    __TEST_windowsOtaSnapshot: () => OtaState;
  };
  global.__TEST_windowsOta = state;
  app.once('ready', () => {
    const updater = getUpdater();
    updater.on('download-progress', (info) =>
      state.events.push({ type: 'progress', percent: info.percent, transferred: info.transferred })
    );
    updater.on('update-downloaded', (info) =>
      state.events.push({ type: 'downloaded', version: info.version })
    );
    updater.on('update-not-available', (info) =>
      state.events.push({ type: 'not-available', version: info.version })
    );
    global.__TEST_windowsOtaSnapshot = () => {
      state.cache = {
        base: updater.app.baseCachePath,
        directory: updater.downloadedUpdateHelper?.cacheDir,
        file: updater.downloadedUpdateHelper?.file,
      };
      state.settings = {
        differentialDisabled: updater.disableDifferentialDownload,
        blockmapOverride: updater.previousBlockmapBaseUrlOverride,
        installDirectory: updater.installDirectory,
      };
      return state;
    };
  });
}

async function cleanupOwned(file: string) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const owned = JSON.parse(await readFile(file, 'utf8')) as Ownership;
  assert(/^TEST-updater-windows-[a-f0-9-]+$/u.test(owned.firewallGroup));
  assert(owned.firewallNames.every((name) => name.startsWith(`${owned.firewallGroup}-`)));
  assert.equal(path.basename(owned.profileFile), 'profile-ownership.json');
  assert.equal(path.dirname(path.resolve(owned.profileFile)), path.dirname(path.resolve(file)));
  const output = path.dirname(path.resolve(file));
  const native = await windowsNative(owned.root, output);
  // Stop every installer before the app: NSIS --force-run can create a late
  // successor while installer cleanup is still running.
  for (const executable of owned.installers) {
    await native.stop(await native.processes(executable));
    assert.equal(
      (await native.processes(executable)).length,
      0,
      'Keep containment while an owned process remains'
    );
  }
  // Alias installer processes are matched through kernel canonical paths.
  const observer = await windowsOtaObserver(owned.root, output);
  for (const executable of owned.installers) {
    if (await absent(executable)) continue;
    await observer.stop(await observer.processes(executable));
    assert.equal((await observer.processes(executable)).length, 0);
  }
  await native.stop(await native.processes(owned.executable));
  // Recheck all owned canonical paths and pending aliases immediately before
  // restoring networking or releasing the physical profile links.
  for (const executable of [owned.executable, ...owned.installers]) {
    assert.equal((await native.processes(executable)).length, 0);
    if (!(await absent(executable))) assert.equal((await observer.processes(executable)).length, 0);
  }
  assert.deepEqual(await native.removeFirewall(owned.firewallGroup, owned.firewallNames), []);
  if (!(await absent(owned.profileFile))) {
    const profile = JSON.parse(await readFile(owned.profileFile, 'utf8')) as ProfileOwnership;
    assert.equal(profile.root, owned.root);
    await releasePhysicalProfile(profile);
  }
}

function checkedMode(value: string): 'fresh' | 'full' | 'cold' | 'warm' {
  assert(value === 'fresh' || value === 'full' || value === 'cold' || value === 'warm');
  return value;
}

async function run() {
  const args = process.argv.slice(2);
  function option(name: string) {
    const index = args.indexOf(name);
    const value = args[index + 1];
    assert(index >= 0 && value, `Required ${name}`);
    return value;
  }
  if (args.includes('--cleanup')) {
    await cleanupOwned(path.resolve(option('--cleanup')));
    return;
  }
  const mode = checkedMode(option('--mode'));
  assert.equal(process.platform, 'win32');
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Only a disposable GitHub Windows VM is authorized'
  );
  assert(process.arch === 'x64' || process.arch === 'arm64');
  const input = path.resolve(option('--inputs'));
  const output = path.resolve(option('--evidence'));
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-')));
  const install = path.join(root, 'install');
  const executable = path.join(install, 'AgentTeamsAI.exe');
  const priorInstaller = path.join(root, 'prior.Setup.exe');
  const targetInstaller = path.join(root, 'target.Setup.exe');
  const firewallGroup = `TEST-updater-windows-${randomUUID()}`;
  const ownershipFile = path.join(output, 'ownership.json');
  const owned: Ownership = {
    root,
    executable,
    installers: [priorInstaller, targetInstaller],
    firewallGroup,
    firewallNames: [],
    profileFile: path.join(output, 'profile-ownership.json'),
  };
  const evidence: Record<string, unknown> = {
    passed: false,
    fullOtaProved: false,
    freshInstallProved: false,
    mode,
    arch: process.arch,
    startedAt: new Date().toISOString(),
    root,
  };
  const native = await windowsNative(root, output);
  const observer = await windowsOtaObserver(root, output);
  let mirror: Awaited<ReturnType<typeof windowsOtaMirror>> | undefined;
  let main: Cdp | undefined;
  let renderer: Cdp | undefined;
  let physical: PhysicalProfile | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let logError: Error | undefined;
  let targetVersion = '';
  let samplerStop = false;
  let sampler: Promise<void> | undefined;
  const installerSamples: WindowsProcess[] = [];
  const spawnedChildren: { kind: 'app' | 'installer'; child: ChildProcess }[] = [];
  const log = createWriteStream(path.join(output, 'desktop.log'));
  log.on('error', (error) => {
    logError = error;
  });
  async function saveOwnership() {
    await writeFile(ownershipFile, JSON.stringify(owned, null, 2));
  }
  async function proveFirewall(programs: string[]) {
    const rules = await native.firewall(firewallGroup);
    assert.equal(rules.length, owned.firewallNames.length);
    for (const rule of rules) {
      assert(owned.firewallNames.includes(rule.name));
      assert.equal(rule.enabled, 'True');
      assert.equal(rule.direction, 'Outbound');
      assert.equal(rule.action, 'Block');
      assert.equal(rule.remote.length, 3, 'IPv4/IPv6 non-loopback containment required');
      assert(programs.some((program) => program.toLowerCase() === rule.program.toLowerCase()));
    }
    return rules;
  }
  async function state() {
    assert(main);
    const current = await main.evaluate<TransportState>('globalThis.__TEST_nativeUpdater');
    if (current?.error) throw new Error(current.error);
    return current;
  }
  async function ota() {
    assert(main);
    return main.evaluate<OtaState>('globalThis.__TEST_windowsOtaSnapshot()');
  }
  async function screenshot(name: string) {
    assert(renderer);
    const result = await renderer.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'));
  }
  async function point(pattern: string) {
    assert(renderer);
    return cdpButtonPoint(renderer, pattern);
  }
  async function click(pattern: string) {
    const location = await waitFor(() => point(pattern), `actionable ${pattern}`);
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
  async function config() {
    return JSON.parse(
      await readFile(path.join(root, 'claude', 'agent-teams-config.json'), 'utf8')
    ) as { general: { theme: string } };
  }
  async function reservePort() {
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
  async function targets(port: number) {
    try {
      const result = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      return result.ok ? ((await result.json()) as Target[]) : null;
    } catch {
      return null;
    }
  }
  async function proveInstalled(version: string) {
    const packageBytes = (
      await readAsar(path.join(install, 'resources', 'app.asar'), ['package.json'])
    ).get('package.json');
    assert(packageBytes);
    const metadata = JSON.parse(packageBytes.toString()) as {
      version: string;
      main: string;
      name: string;
    };
    assert.equal(metadata.version, version);
    assert.equal(metadata.name, 'agent-teams-ai');
    assert.equal(metadata.main, 'dist-electron/main/index.cjs');
    const pe = await readPeArchitecture(executable);
    assert.equal(pe.architecture, process.arch);
    const signature = await native.signature(executable);
    assert(['Valid', 'NotSigned'].includes(signature.status));
    assert(signature.productVersion.includes(version));
    return {
      executable: await hashFile(executable),
      asar: await hashFile(path.join(install, 'resources', 'app.asar')),
      packageVersion: version,
      architecture: pe.architecture,
      signature,
    };
  }
  async function launch(version: string) {
    assert(mirror && env && physical);
    await readInspectorFuse(executable);
    const mainPort = await reservePort();
    const rendererPort = await reservePort();
    const arguments_ = [
      `--inspect-brk=127.0.0.1:${mainPort}`,
      `--remote-debugging-port=${rendererPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--lang=en-US',
    ];
    const app = spawn(executable, arguments_, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedChildren.push({ kind: 'app', child: app });
    const launchErrors: string[] = [];
    app.on('error', (error) => launchErrors.push(String(error)));
    assert(app.pid);
    for (const stream of [app.stdout, app.stderr])
      stream?.on('data', (chunk: Buffer) => log.write(chunk));
    const owner = await waitFor(
      async () => (await native.processes(executable)).find((item) => item.pid === app.pid) ?? null,
      'owned real Windows main process'
    );
    const inspector = await waitFor(async () => {
      assert.equal(launchErrors.length, 0, launchErrors.join('\n'));
      assert.equal(app.exitCode, null);
      return (await targets(mainPort))?.find((item) => item.webSocketDebuggerUrl) ?? null;
    }, 'official main inspector');
    main = await Cdp.connect(inspector.webSocketDebuggerUrl);
    await main.send('Debugger.enable');
    await main.send('Runtime.runIfWaitingForDebugger');
    const paused = await waitFor(
      () =>
        Promise.resolve(
          (main!.events.find((event) => event.method === 'Debugger.paused')?.params as
            | Pause
            | undefined) ?? null
        ),
      'original packaged CJS entry pause'
    );
    const frame = paused.callFrames[0];
    assert(frame);
    const filename = await main.evaluate<string>('__filename', frame.callFrameId);
    assert(
      filename.replaceAll('\\', '/').endsWith('/resources/app.asar/dist-electron/main/index.cjs')
    );
    await cdpCallFunction(
      main,
      `(()=>{const originalRequire=require;const getUpdater=()=>autoUpdater;return (origin,paths)=>{(${cdpSerializedFunction(transportHook)})(originalRequire('electron'),getUpdater,origin,paths);(${cdpSerializedFunction(observeOta)} )(originalRequire('electron').app,getUpdater);};})()`,
      [mirror.origin, mirror.paths],
      frame.callFrameId
    );
    await main.send('Debugger.resume');
    const roots = await waitFor(async () => {
      const value = await state();
      return value.roots ? value : null;
    }, 'original bundled updater and default physical profile');
    assert.equal(roots.roots?.version, version);
    assert.equal(roots.roots?.arch, process.arch);
    assert.equal(roots.roots?.packaged, true);
    assert.equal(roots.roots?.home.toLowerCase(), physical.home.toLowerCase());
    assert.equal(
      roots.roots?.userData.toLowerCase(),
      path.join(physical.roaming, 'agent-teams-ai').toLowerCase()
    );
    assert.equal(
      (await realpath(roots.roots.userData)).toLowerCase(),
      path.join(root, 'user-data').toLowerCase()
    );
    assert.equal(roots.updater?.class, 'NsisUpdater');
    assert.deepEqual(roots.bound, ['default', 'electron-updater']);
    const page = await waitFor(
      async () =>
        (await targets(rendererPort))?.find(
          (item) => item.type === 'page' && item.url.startsWith('file:')
        ) ?? null,
      'real packaged renderer'
    );
    renderer = await Cdp.connect(page.webSocketDebuggerUrl);
    await renderer.send('Page.enable');
    await waitFor(
      () =>
        renderer!.evaluate<boolean | null>(
          '!document.getElementById("splash") && document.readyState === "complete" ? true : null'
        ),
      'real painted renderer'
    );
    const observed = await ota();
    assert.equal(observed.settings?.differentialDisabled, false);
    assert.equal(observed.settings?.blockmapOverride, null);
    assert.equal(observed.settings?.installDirectory, undefined);
    assert.equal(observed.cache?.base.toLowerCase(), physical.local.toLowerCase());
    return { owner, arguments: arguments_, roots };
  }
  async function nativePaint(owner: WindowsProcess, name: string) {
    const directory = path.join(root, `capture-${name}`);
    await mkdir(directory);
    const deadline = Date.now() + 45_000;
    const attempts: unknown[] = [];
    const receipt = path.join(output, `${name}-native.json`);
    const identity = { pid: owner.pid, start: owner.start, sid: owner.sid, session: owner.session };
    // Read only the existing inspector; the automatic NSIS successor has no inspector.
    const accessibility =
      name === 'automatic-successor' || !main
        ? { available: false, reason: 'No existing main inspector for this owner' }
        : await main
            .evaluate<boolean>('require("electron").app.isAccessibilitySupportEnabled()')
            .then((enabled) => ({ available: true, enabled }))
            .catch(() => ({ available: false, reason: 'Existing inspector AX state unavailable' }));
    const persist = (details: object = {}) =>
      writeFile(
        receipt,
        JSON.stringify({ identity, accessibility, attempts, ...details }, null, 2)
      );
    try {
      const result = await waitFor(
        async () => {
          assert(attempts.length < 512, 'Native paint attempt budget exceeded');
          const window = await native.capture(owner, path.join(directory, 'native.png'));
          if (!window) {
            attempts.push({ window: null, ready: false, at: new Date().toISOString() });
            await persist();
            return null;
          }
          const image = path.join(output, `${name}-native.png`);
          await copyFile(window.screenshot, image);
          const pixels = await hashFile(image);
          const attempt = {
            window,
            image: pixels,
            observation: null as Awaited<ReturnType<typeof observer.names>> | null,
            ready: false,
            at: new Date().toISOString(),
          };
          attempts.push(attempt);
          await persist(); // Actual pixels survive any subsequent UIA/content failure.
          assert((await stat(image)).size > 1000);
          assertCaptionProof(owner.pid, window.hwnd, window.caption);
          attempt.observation = await observer.names(owner, window.hwnd);
          await persist(); // Includes UIA Error/HResult and partial owned subtree counters.
          assertNativeNames(owner.pid, window.hwnd, attempt.observation);
          const names = attempt.observation.Names;
          const text = names.join('\n');
          const contentReady =
            name === 'available'
              ? text.includes(targetVersion) && /^Download$/imu.test(text)
              : /Providers\s*&\s*plans/iu.test(text) && /^Tasks$/imu.test(text);
          attempt.ready = contentReady && !/Preparing workspace/iu.test(text);
          await persist();
          if (!attempt.ready) return null;
          assert(Date.now() <= deadline, 'Automatic real desktop must paint within 45 seconds');
          const current = (await native.processes(executable)).find(
            (item) => item.pid === owner.pid
          );
          assert(current, 'Owned process disappeared after native paint');
          assert.equal(current.start, owner.start);
          assert.equal(current.sid, owner.sid);
          assert.equal(current.session, owner.session);
          return {
            ...window,
            screenshot: image,
            image: pixels,
            names,
            attempts,
            accessibility,
            ready: true,
            timeoutMs: 45_000,
          };
        },
        'real owned HWND accessibility content and screenshot',
        45_000
      );
      await persist(result);
      return result;
    } catch (error) {
      await persist({ ready: false, error: String(error).slice(0, 4096) });
      throw error;
    }
  }
  async function finishEvidence() {
    if (logError) {
      evidence.logError = String(logError);
      evidence.passed = false;
      process.exitCode = 1;
    }
    evidence.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(evidence, null, 2));
    if (
      mode === 'fresh' &&
      evidence.passed !== true &&
      !(await absent(path.join(output, 'fresh-reference.json')))
    )
      await unlink(path.join(output, 'fresh-reference.json'));
  }
  async function proveFresh({
    inputs,
    target,
    initial,
  }: {
    inputs: Awaited<ReturnType<typeof windowsInputs>>;
    target: Awaited<ReturnType<typeof windowsInputs>>['verified'][number];
    initial: Awaited<ReturnType<typeof launch>>;
  }) {
    assert(mirror);
    const version = inputs.targetVersion;
    await waitFor(
      async () =>
        (await ota()).events.some(
          (event) => event.type === 'not-available' && event.version === version
        )
          ? true
          : null,
      'original target provider no-update'
    );
    evidence.nativeWindow = await nativePaint(initial.owner, 'fresh');
    await screenshot('fresh-renderer');
    assert.equal(
      mirror.requests.filter((entry) => entry.method === 'GET' && entry.path.endsWith('.exe'))
        .length,
      0
    );
    evidence.transport = await state();
    evidence.events = await ota();
    proveWindowsProvider(mirror.requests, targetVersion);
    evidence.freshInstallProved = true;
    const reference: FreshReference = {
      passed: true,
      arch: process.arch,
      inputDigest: inputs.inputDigest,
      installerSha256: target.sha256,
      installed: await proveInstalled(version),
    };
    await writeFile(path.join(output, 'fresh-reference.json'), JSON.stringify(reference, null, 2));
  }
  async function proveOta({
    mode,
    inputs,
    target,
    prior,
    initial,
    session,
    pending,
  }: {
    inputs: Awaited<ReturnType<typeof windowsInputs>>;
    target: Awaited<ReturnType<typeof windowsInputs>>['verified'][number];
    initial: Awaited<ReturnType<typeof launch>>;
    mode: 'full' | 'cold' | 'warm';
    prior: Awaited<ReturnType<typeof windowsInputs>>['verified'][number];
    session: Awaited<ReturnType<typeof native.session>>;
    pending: string;
  }) {
    assert(mirror);
    const reference = JSON.parse(
      await readFile(path.resolve(option('--fresh-reference')), 'utf8')
    ) as FreshReference;
    assert.equal(reference.passed, true);
    assert.equal(reference.arch, process.arch);
    assert.equal(reference.inputDigest, inputs.inputDigest);
    assert.equal(reference.installerSha256, target.sha256);
    assert.equal(reference.installed.packageVersion, targetVersion);
    evidence.freshReference = reference;
    await waitFor(async () => {
      const current = await state();
      return current.updater?.provider === 'GitHubProvider' &&
        current.events.some(
          (event) => event.type === 'available' && event.version === targetVersion
        )
        ? true
        : null;
    }, 'genuine candidate from original GitHubProvider');
    await waitFor(
      () => cdpBodyContains(renderer!, targetVersion),
      'service-validated new version reaches UI'
    );
    if (await point('^Later$')) await click('^Later$');
    await waitFor(
      () => renderer!.evaluate<boolean | null>('document.querySelector("[role=dialog]")?null:true'),
      'dismiss available dialog before Settings'
    );
    for (const type of ['keyDown', 'keyUp'])
      await renderer!.send('Input.dispatchKeyEvent', {
        type,
        key: ',',
        code: 'Comma',
        modifiers: 2,
      });
    await click('^Light$');
    await waitFor(async () => {
      if (await absent(path.join(root, 'claude', 'agent-teams-config.json'))) return null;
      return (await config()).general.theme === 'light' ? true : null;
    }, 'preference persisted by actual Settings UI');
    evidence.profileBefore = await config();
    await screenshot('profile-before');
    await click('^Advanced$');
    const available = (await state()).events.filter((event) => event.type === 'available').length;
    await click(`^(?:Check for updates|v?${targetVersion.replaceAll('.', '\\.')} available)$`);
    await waitFor(
      async () =>
        (await state()).events.filter((event) => event.type === 'available').length > available
          ? true
          : null,
      'real manual update check'
    );
    if (!(await point('^Download$'))) await click('^(?:Update app|View details)$');
    await waitFor(() => point('^Download$'), 'original Download button');
    await screenshot('available');
    evidence.availableNative = await nativePaint(initial.owner, 'available');
    const cachedInstaller = path.join(root, 'cache', 'installer.exe');
    const cachedBlockmap = path.join(root, 'cache', 'current.blockmap');
    assert.equal(
      (await hashFile(cachedInstaller)).sha256,
      prior.sha256,
      'Actual initial NSIS must seed the exact prior installer cache'
    );
    assert(await absent(cachedBlockmap));
    assert(await absent(path.join(root, 'cache', 'pending')));
    if (mode === 'full') await unlink(cachedInstaller);
    if (mode === 'warm') {
      await copyFile(path.join(input, `${prior.name}.blockmap`), cachedBlockmap);
      evidence.warmCacheFixture = {
        provenance:
          'Official pinned prior blockmap staged as deterministic existing updater cache; no simulated updater API',
        hash: await hashFile(cachedBlockmap),
      };
    }
    evidence.cacheBefore = {
      installerPresent: !(await absent(cachedInstaller)),
      blockmapPresent: !(await absent(cachedBlockmap)),
      mode,
    };
    evidence.downloadAction = await click('^Download$');
    await waitFor(
      async () =>
        (await ota()).events.some(
          (event) =>
            event.type === 'progress' && (event.percent ?? 0) > 0 && (event.percent ?? 100) < 100
        )
          ? true
          : null,
      'genuine original download progress',
      120_000
    );
    evidence.progressUi = await waitFor(
      () =>
        renderer!.evaluate<string | null>(
          '(() => {const b=[...document.querySelectorAll("button")].find(b=>/\\d+%/.test(b.textContent));if(!b)return null;const r=b.getBoundingClientRect();return r.width&&r.height?b.textContent.trim():null;})()'
        ),
      'visible updater progress'
    );
    await screenshot('progress');
    await waitFor(
      async () =>
        (await ota()).events.some(
          (event) => event.type === 'downloaded' && event.version === targetVersion
        )
          ? true
          : null,
      'genuine downloaded event',
      180_000
    );
    const downloaded = await ota();
    assert(downloaded.cache?.directory && downloaded.cache.file);
    assert.equal(
      (await realpath(downloaded.cache.directory)).toLowerCase(),
      path.join(root, 'cache').toLowerCase()
    );
    assert.equal((await realpath(downloaded.cache.file)).toLowerCase(), pending.toLowerCase());
    const pendingHash = await hashFile(pending);
    assert.equal(pendingHash.sha256, target.sha256);
    assert.equal(pendingHash.sha512, target.sha512);
    assert.equal(pendingHash.size, target.size);
    evidence.downloadedInstaller = {
      path: downloaded.cache.file,
      canonical: pending,
      hash: pendingHash,
      signature: await native.signature(pending),
    };
    evidence.downloadMode = proveWindowsDownload(
      mirror.requests,
      mode,
      target,
      `${prior.name}.blockmap`,
      await readFile(path.join(output, 'desktop.log'), 'utf8')
    );
    proveWindowsProvider(mirror.requests, targetVersion, target.name);
    const aliasRule = `${firewallGroup}-${owned.firewallNames.length}`;
    owned.firewallNames.push(aliasRule);
    await saveOwnership();
    await observer.addPendingFirewall(firewallGroup, aliasRule, downloaded.cache.file, pending);
    evidence.firewall = await proveFirewall([
      executable,
      ...owned.installers,
      downloaded.cache.file,
    ]);
    if (!(await point('^Restart now$'))) await click('^(?:Restart to update|View details)$');
    await waitFor(() => point('^Restart now$'), 'actual restart action');
    await screenshot('downloaded');
    evidence.updaterEvents = downloaded;
    evidence.transport = await state();
    const before = new Set((await native.processes(executable)).map((owner) => owner.pid));
    assert(await absent(observer.watchReadyFile));
    sampler = (async () => {
      while (!samplerStop) installerSamples.push(...(await observer.watchInstaller(pending)));
    })();
    // Observe completion immediately so a sampler failure cannot be unhandled.
    let samplerError: Error | undefined;
    const sampling = sampler.catch((error: unknown) => {
      samplerError =
        error instanceof Error
          ? error
          : new Error('Native installer sampler failed', { cause: error });
    });
    await waitFor(async () => {
      if (samplerError) throw samplerError;
      return (await absent(observer.watchReadyFile)) ? null : true;
    }, 'pending installer sampler actively watching');
    evidence.installAction = await click('^Restart now$');
    main?.close();
    renderer?.close();
    main = undefined;
    renderer = undefined;
    const successor = await waitFor(
      async () =>
        (await native.processes(executable)).find(
          (owner) => !before.has(owner.pid) && !/\s--type=/u.test(owner.command)
        ) ?? null,
      'NSIS-created automatic successor before any harness relaunch',
      process.arch === 'arm64' ? 480_000 : 90_000
    );
    samplerStop = true;
    await sampling;
    if (samplerError) throw samplerError;
    assert.equal(successor.sid, session.sid);
    assert.equal(successor.session, session.session);
    assert(new Date(successor.start).getTime() >= new Date(initial.owner.start).getTime());
    assert(!/inspect|remote-debugging|--no-sandbox/iu.test(successor.command));
    assert(/\s--updated(?:\s|$)/u.test(successor.command));
    assert(
      !(await native.processes(executable)).some(
        (owner) => owner.pid === initial.owner.pid && owner.start === initial.owner.start
      ),
      'Prior app must actually quit'
    );
    const installerProcess = installerSamples.find(
      (owner) =>
        /\s--updated(?:\s|$)/u.test(owner.command) &&
        /\s\/S(?:\s|$)/u.test(owner.command) &&
        /\s--force-run(?:\s|$)/u.test(owner.command)
    );
    assert(
      installerProcess,
      'Observe the actual original NsisUpdater pending installer and arguments'
    );
    assert.equal(installerProcess.sid, session.sid);
    assert.equal(installerProcess.session, session.session);
    evidence.installerProcesses = installerSamples;
    const installed = await proveInstalled(targetVersion);
    assert.equal(installed.executable.sha256, reference.installed.executable.sha256);
    assert.equal(installed.asar.sha256, reference.installed.asar.sha256);
    for (const field of [
      'status',
      'subject',
      'thumbprint',
      'fileVersion',
      'productVersion',
    ] as const)
      assert.equal(installed.signature[field], reference.installed.signature[field]);
    evidence.automaticSuccessor = { owner: successor, installed };
    evidence.automaticWindow = await nativePaint(successor, 'automatic-successor');
    assert.equal((await config()).general.theme, 'light');
    evidence.profileAfterAutomatic = await config();
    evidence.automaticSuccessorProved = true;
    evidence.automaticProofAt = new Date().toISOString();
    await native.stop(await native.processes(executable));
    assert.equal((await native.processes(executable)).length, 0);
    const diagnosticRequestStart = mirror.requests.length;
    const installerGets = mirror.requests.filter(
      (entry) => entry.method === 'GET' && entry.path.endsWith('.exe')
    ).length;
    evidence.diagnosticRelaunchAfterAutomaticProof = await launch(targetVersion);
    await waitFor(
      async () =>
        (await ota()).events.some(
          (event) => event.type === 'not-available' && event.version === targetVersion
        )
          ? true
          : null,
      'new installed original updater no-update'
    );
    assert.equal(
      await renderer!.evaluate<boolean>('document.documentElement.classList.contains("light")'),
      true
    );
    assert.equal((await config()).general.theme, 'light');
    proveWindowsProvider(mirror.requests.slice(diagnosticRequestStart), targetVersion);
    assert.equal(
      mirror.requests.filter((entry) => entry.method === 'GET' && entry.path.endsWith('.exe'))
        .length,
      installerGets,
      'Updated app must not download another installer'
    );
    await screenshot('post-update');
    evidence.postUpdate = {
      events: await ota(),
      transport: await state(),
      profile: await config(),
    };
    evidence.fullOtaProved = true;
  }
  async function proveScenario(values: Omit<Parameters<typeof proveOta>[0], 'mode'>) {
    if (mode === 'fresh') await proveFresh(values);
    else await proveOta({ mode, ...values });
  }
  try {
    await saveOwnership();
    await mkdir(install);
    const session = await native.session();
    evidence.desktopSession = session;
    assert.equal(session.station.toLowerCase(), 'winsta0');
    assert.equal(session.desktop.toLowerCase(), 'default');
    physical = await native.physicalProfile();
    evidence.physicalProfile = await ownPhysicalProfile(root, physical, output);
    const systemRoot = inheritedWindowsEnvironment('SystemRoot');
    assert(systemRoot);
    env = appEnvironment(physical, root, systemRoot);
    evidence.environmentKeys = Object.keys(env);
    const inputs = await windowsInputs(input, readWindowsInputMode());
    evidence.inputs = inputs.verified;
    evidence.inputDigest = inputs.inputDigest;
    targetVersion = inputs.targetVersion;
    evidence.targetBinding = {
      targetVersion,
      legacyFixture: inputs.legacyFixture,
      plan: inputs.plan,
      stagedMetadata: inputs.stagedMetadata,
    };
    const prior = inputs.verified.find(
      (pin) => pin.arch === process.arch && pin.tag === 'v2.17.1' && pin.name.endsWith('.exe')
    );
    const target = inputs.verified.find(
      (pin) =>
        pin.arch === process.arch && pin.tag === inputs.target.tag_name && pin.name.endsWith('.exe')
    );
    assert(prior && target);
    const pending = path.join(root, 'cache', 'pending', target.name);
    owned.installers.push(pending);
    await saveOwnership();
    await copyFile(path.join(input, prior.name), priorInstaller);
    await copyFile(path.join(input, target.name), targetInstaller);
    assert.equal((await hashFile(priorInstaller)).sha256, prior.sha256);
    assert.equal((await hashFile(targetInstaller)).sha256, target.sha256);
    const signatures = {
      prior: await native.signature(priorInstaller),
      target: await native.signature(targetInstaller),
    };
    for (const signature of Object.values(signatures))
      assert(['Valid', 'NotSigned'].includes(signature.status));
    evidence.signatures = signatures;
    for (const program of [executable, ...owned.installers]) {
      const name = `${firewallGroup}-${owned.firewallNames.length}`;
      owned.firewallNames.push(name);
      await saveOwnership();
      await native.addFirewall(firewallGroup, name, program);
    }
    evidence.initialFirewall = await proveFirewall([executable, ...owned.installers]);
    const installer = mode === 'fresh' ? targetInstaller : priorInstaller;
    const setup = spawn(installer, ['/S', `/D=${install}`], {
      cwd: root,
      env,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(process.arch === 'arm64' ? 480_000 : 180_000),
    });
    spawnedChildren.push({ kind: 'installer', child: setup });
    for (const stream of [setup.stdout, setup.stderr])
      stream?.on('data', (chunk: Buffer) => log.write(chunk));
    const setupCode = await new Promise<number | null>((resolve, reject) => {
      setup.once('error', reject);
      setup.once('exit', resolve);
    });
    assert.equal(setupCode, 0);
    assert.equal(
      (await native.processes(executable)).length,
      0,
      'Initial installer must not auto-launch'
    );
    evidence.initialInstall = { installer, code: setupCode, arguments: ['/S', `/D=${install}`] };
    evidence.predecessorFixture = await prepareArmPriorFixture({
      mode: mode,
      targetVersion: targetVersion,
      root,
      install,
      priorInstaller,
      actualNsisExitCode: setupCode,
      env,
      native,
      recordListing: async (receipt) => {
        await writeFile(
          path.join(output, 'prior-archive-listing.json'),
          JSON.stringify(receipt, null, 2)
        );
      },
      recordDecoded: async (ledger) => {
        await writeFile(
          path.join(output, 'prior-decoded-pe.json'),
          JSON.stringify(ledger, null, 2)
        );
      },
      ownDecoder: async (file) => {
        owned.installers.push(file);
        const name = `${firewallGroup}-${owned.firewallNames.length}`;
        owned.firewallNames.push(name);
        await saveOwnership();
        await native.addFirewall(firewallGroup, name, file);
      },
    });
    const version = mode === 'fresh' ? targetVersion : '2.17.1';
    evidence.installedBefore = await proveInstalled(version);
    const originalFiles = [
      'package.json',
      'dist-electron/main/index.cjs',
      'node_modules/electron-updater/out/NsisUpdater.js',
      'node_modules/electron-updater/out/AppUpdater.js',
      'node_modules/electron-updater/out/providers/GitHubProvider.js',
    ];
    const source = await readAsar(path.join(install, 'resources', 'app.asar'), originalFiles);
    const sourceDirectory = path.join(output, 'actual-installed-source');
    await mkdir(sourceDirectory);
    const sources = [];
    for (const [name, bytes] of source) {
      await writeFile(path.join(sourceDirectory, name.replaceAll('/', '__')), bytes);
      sources.push({
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    evidence.sources = sources;
    const bundledMain = source.get('dist-electron/main/index.cjs')?.toString();
    assert(
      bundledMain &&
        (/\bconst\s+autoUpdater\s*=/u.test(bundledMain) ||
          /\bconst\s+\{\s*autoUpdater\s*\}\s*=\s*electronUpdater\b/u.test(bundledMain))
    );
    const appUpdateText = await readFile(path.join(install, 'resources', 'app-update.yml'), 'utf8');
    await writeFile(path.join(output, 'app-update.yml'), appUpdateText);
    const appUpdate = parse(appUpdateText) as {
      provider: string;
      owner: string;
      repo: string;
      releaseType: string;
      updaterCacheDirName: string;
    };
    assert.equal(appUpdate.provider, 'github');
    assert.equal(appUpdate.owner, '777genius');
    assert.equal(appUpdate.repo, 'agent-teams-ai');
    assert.equal(appUpdate.releaseType, 'release');
    assert.equal(appUpdate.updaterCacheDirName, 'agent-teams-ai-updater');
    evidence.appUpdate = appUpdate;
    mirror = await windowsOtaMirror(inputs, input);
    await writeFile(path.join(output, 'latest.yml'), inputs.feed);
    const initial = await launch(version);
    assert.equal(initial.owner.sid, session.sid);
    assert.equal(initial.owner.session, session.session);
    evidence.initialLaunch = initial;
    await proveScenario({ inputs, target, prior, initial, session, pending });
    assert(!logError);
    evidence.passed = true;
    evidence.finalPromotionFeed = Boolean(inputs.stagedMetadata);
    evidence.finalReleaseProved =
      inputs.legacyFixture === false &&
      targetVersion === '2.17.6' &&
      Boolean(inputs.stagedMetadata);
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
    evidence.failureUi = await renderer?.evaluate('document.body.innerText').catch(() => undefined);
    evidence.lastTransport = await main
      ?.evaluate('globalThis.__TEST_nativeUpdater')
      .catch(() => undefined);
    await screenshot('failure').catch(() => undefined);
  } finally {
    main?.close();
    renderer?.close();
    samplerStop = true;
    await sampler?.catch((error: unknown) => {
      evidence.samplerError = String(error);
      evidence.passed = false;
      process.exitCode = 1;
    });
    try {
      await cleanupOwned(ownershipFile);
      evidence.cleanup = { passed: true };
    } catch (error) {
      evidence.cleanup = { passed: false, error: String(error) };
      evidence.passed = false;
      process.exitCode = 1;
      // PID proof failed. Release only handles returned by our own spawn calls;
      // send no cleanup signal and retain Firewall/profile containment.
      evidence.unresolvedChildren = spawnedChildren.map(({ kind, child }) => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        return {
          kind,
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          signalSent: false,
        };
      });
    }
    evidence.requests = mirror?.requests;
    await mirror?.close().catch((error: unknown) => {
      evidence.mirrorCleanupError = String(error);
      evidence.passed = false;
      process.exitCode = 1;
    });
    await new Promise<void>((resolve) => {
      if (log.destroyed) resolve();
      else log.end(resolve);
    });
    await finishEvidence();
  }
}
await run();
