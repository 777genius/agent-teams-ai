import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
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
import { readWindowsInputMode, windowsInputs, windowsMirror } from './windows-mirror.mts';
import { readPeArchitecture, windowsNative } from './windows-native.mts';
import {
  appEnvironment,
  absent,
  ownPhysicalProfile,
  releasePhysicalProfile,
} from './windows-ota-profile.mts';
import { inheritedWindowsEnvironment } from './windows-powershell.mts';
import { prepareArmPriorFixture } from './windows-arm-prior-fixture.mts';

import type { TransportState } from './transport.mts';
import type { WindowsProcess } from './windows-native.mts';
import type { ProfileOwnership } from './windows-ota-profile.mts';

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
interface Pause {
  callFrames: { callFrameId: string }[];
}
const args = process.argv.slice(2);
function option(name: string) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  assert(index >= 0 && value, `Required ${name}`);
  return path.resolve(value);
}
const input = option('--inputs');
const output = option('--evidence');
await mkdir(output, { recursive: true });
const evidence: Record<string, unknown> = {
  scope: 'Official Windows NSIS predecessor native availability feasibility',
  passed: false,
  fullOtaProved: false,
  startedAt: new Date().toISOString(),
};
assert.equal(process.platform, 'win32');
assert(['x64', 'arm64'].includes(process.arch));
assert.equal(
  process.env.GITHUB_ACTIONS,
  'true',
  'Only a disposable GitHub Windows VM is authorized'
);
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-')));
const userData = path.join(root, 'user-data');
const install = path.join(root, 'install');
const executable = path.join(install, 'AgentTeamsAI.exe');
const priorInstaller = path.join(root, 'prior.Setup.exe');
const targetInstaller = path.join(root, 'target.Setup.exe');
const firewallGroup = `TEST-updater-windows-${randomUUID()}`;
const firewallNames: string[] = [];
let fixtureDecoder: string | undefined;
const profileFile = path.join(output, 'profile-ownership.json');
let profile: ProfileOwnership | undefined;
const native = await windowsNative(root, output);
let main: Cdp | undefined;
let renderer: Cdp | undefined;
let child: ReturnType<typeof spawn> | undefined;
let mirror: Awaited<ReturnType<typeof windowsMirror>> | undefined;
const log = createWriteStream(path.join(output, 'desktop.log'));
let logError: Error | undefined;
log.on('error', (error) => {
  logError = error;
});
const owners: WindowsProcess[] = [];
evidence.isolation = { root, userData, install, executable, firewallGroup, profileFile };
await writeFile(
  path.join(output, 'ownership.json'),
  JSON.stringify(
    {
      root,
      executable,
      priorInstaller,
      targetInstaller,
      firewallGroup,
      firewallNames,
      profileFile,
    },
    null,
    2
  )
);

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
async function targets(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok ? ((await response.json()) as Target[]) : null;
  } catch {
    return null;
  }
}
async function screenshot(name: string) {
  assert(renderer);
  const result = await renderer.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'));
}
async function state() {
  assert(main);
  const result = await main.evaluate<TransportState>('globalThis.__TEST_nativeUpdater');
  if (result?.error) {
    throw new Error(result.error);
  }
  return result;
}
async function action(pattern: string, click = true) {
  assert(renderer);
  const location = await waitFor(() => cdpButtonPoint(renderer!, pattern), `actionable ${pattern}`);
  if (click) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await renderer.send('Input.dispatchMouseEvent', {
        type,
        x: location.x,
        y: location.y,
        button: 'left',
        clickCount: 1,
      });
    }
  }
  return location;
}

try {
  await mkdir(install);
  const physical = await native.physicalProfile();
  evidence.physicalProfile = physical;
  profile = await ownPhysicalProfile(root, physical, output);
  evidence.profileOwnership = profile;
  const session = await native.session();
  evidence.desktopSession = session;
  assert.equal(
    session.station.toLowerCase(),
    'winsta0',
    'Interactive Console window station required'
  );
  assert.equal(session.desktop.toLowerCase(), 'default', 'Interactive default desktop required');
  const inputs = await windowsInputs(input, readWindowsInputMode());
  evidence.inputs = inputs.verified;
  evidence.inputDigest = inputs.inputDigest;
  const targetVersion = inputs.targetVersion;
  evidence.targetBinding = {
    targetVersion,
    legacyFixture: inputs.legacyFixture,
    plan: inputs.plan,
    stagedMetadata: inputs.stagedMetadata,
  };
  evidence.feed = {
    feasibilityOnly: true,
    sha256: createHash('sha256').update(inputs.feed).digest('hex'),
  };
  await writeFile(path.join(output, 'latest.yml'), inputs.feed);
  const prior = inputs.verified.find(
    (pin) => pin.arch === process.arch && pin.tag === 'v2.17.1' && pin.name.endsWith('.exe')
  );
  const target = inputs.verified.find(
    (pin) =>
      pin.arch === process.arch && pin.tag === inputs.target.tag_name && pin.name.endsWith('.exe')
  );
  assert(prior && target);
  await copyFile(path.join(input, prior.name), priorInstaller);
  await copyFile(path.join(input, target.name), targetInstaller);
  assert.equal((await hashFile(priorInstaller)).sha256, prior.sha256);
  assert.equal((await hashFile(targetInstaller)).sha256, target.sha256);
  evidence.signatures = {
    priorInstaller: await native.signature(priorInstaller),
    targetInstaller: await native.signature(targetInstaller),
  };
  for (const [index, program] of [executable, priorInstaller, targetInstaller].entries()) {
    const name = `${firewallGroup}-${index}`;
    firewallNames.push(name);
    await writeFile(
      path.join(output, 'ownership.json'),
      JSON.stringify(
        {
          root,
          executable,
          priorInstaller,
          targetInstaller,
          firewallGroup,
          firewallNames,
          profileFile,
        },
        null,
        2
      )
    );
    await native.addFirewall(firewallGroup, name, program);
  }
  const rules = await native.firewall(firewallGroup);
  evidence.firewall = rules;
  assert.equal(rules.length, 3);
  for (const rule of rules) {
    assert(firewallNames.includes(rule.name));
    assert.equal(rule.enabled, 'True');
    assert.equal(rule.action, 'Block');
    assert.equal(rule.direction, 'Outbound');
    assert(
      [executable, priorInstaller, targetInstaller].some(
        (program) => program.toLowerCase() === rule.program.toLowerCase()
      )
    );
    assert.equal(rule.remote.length, 3, 'IPv4/IPv6 non-loopback containment required');
  }
  const systemRoot = inheritedWindowsEnvironment('SystemRoot');
  assert(systemRoot);
  const env = appEnvironment(physical, root, systemRoot);
  evidence.childEnvironmentKeys = Object.keys(env);
  const setup = spawn(priorInstaller, ['/S', `/D=${install}`], {
    cwd: root,
    env,
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(process.arch === 'arm64' ? 480_000 : 180_000),
  });
  setup.on('error', (error) => {
    evidence.installError = String(error);
  });
  for (const stream of [setup.stdout, setup.stderr]) {
    stream?.on('data', (chunk: Buffer) => log.write(chunk));
  }
  const setupCode = await new Promise<number | null>((resolve, reject) => {
    setup.once('error', reject);
    setup.once('exit', resolve);
  });
  evidence.priorInstall = { code: setupCode, arguments: ['/S', `/D=${install}`] };
  assert.equal(setupCode, 0, 'Official NSIS prior installation failed');
  assert.equal(
    (await native.processes(executable)).length,
    0,
    'Prior installer unexpectedly auto-launched before transport hooks'
  );
  evidence.predecessorFixture = await prepareArmPriorFixture({
    mode: 'predecessor',
    targetVersion: inputs.targetVersion,
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
      await writeFile(path.join(output, 'prior-decoded-pe.json'), JSON.stringify(ledger, null, 2));
    },
    ownDecoder: async (file) => {
      fixtureDecoder = file;
      const name = `${firewallGroup}-${firewallNames.length}`;
      firewallNames.push(name);
      const ownershipFile = path.join(output, 'ownership.json');
      const owned = JSON.parse(await readFile(ownershipFile, 'utf8')) as Record<string, unknown>;
      await writeFile(
        ownershipFile,
        JSON.stringify({ ...owned, fixtureDecoder, firewallNames }, null, 2)
      );
      await native.addFirewall(firewallGroup, name, file);
    },
  });
  evidence.pe = await readPeArchitecture(executable);
  assert.equal(
    (evidence.pe as { architecture: string }).architecture,
    process.arch,
    'Native installed PE must match runner architecture'
  );
  evidence.installedSignature = await native.signature(executable);
  evidence.fuse = await readInspectorFuse(executable);
  const names = [
    'package.json',
    'dist-electron/main/index.cjs',
    'node_modules/electron-updater/package.json',
    'node_modules/electron-updater/out/main.js',
    'node_modules/electron-updater/out/NsisUpdater.js',
    'node_modules/electron-updater/out/AppUpdater.js',
    'node_modules/electron-updater/out/BaseUpdater.js',
    'node_modules/electron-updater/out/DownloadedUpdateHelper.js',
    'node_modules/electron-updater/out/providers/Provider.js',
    'node_modules/electron-updater/out/providers/GitHubProvider.js',
    'node_modules/electron-updater/out/electronHttpExecutor.js',
  ];
  const sourceDirectory = path.join(output, 'actual-predecessor-source');
  await mkdir(sourceDirectory);
  const sources = await readAsar(path.join(install, 'resources', 'app.asar'), names);
  const ledger = [];
  for (const [name, bytes] of sources) {
    await writeFile(path.join(sourceDirectory, name.replaceAll('/', '__')), bytes);
    ledger.push({
      source: name,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  evidence.sources = ledger;
  const packageBytes = sources.get('package.json');
  const mainBytes = sources.get('dist-electron/main/index.cjs');
  assert(packageBytes && mainBytes);
  const metadata = JSON.parse(packageBytes.toString()) as {
    version: string;
    main: string;
    type?: string;
  };
  assert.equal(metadata.version, '2.17.1');
  assert.equal(metadata.main, 'dist-electron/main/index.cjs');
  const bundledMain = mainBytes.toString();
  assert(
    /\bconst\s+autoUpdater\s*=/.test(bundledMain) ||
      /\bconst\s+\{\s*autoUpdater\s*\}\s*=\s*electronUpdater\b/.test(bundledMain),
    'Actual bundled updater lexical binding must be inspected'
  );
  const appUpdate = await readFile(path.join(install, 'resources', 'app-update.yml'), 'utf8');
  await writeFile(path.join(sourceDirectory, 'app-update.yml'), appUpdate);
  const configuration = parse(appUpdate) as {
    provider: string;
    owner: string;
    repo: string;
    releaseType: string;
  };
  assert.equal(configuration.provider, 'github');
  assert.equal(configuration.owner, '777genius');
  assert.equal(configuration.repo, 'agent-teams-ai');
  assert.equal(configuration.releaseType, 'release');
  evidence.appUpdate = configuration;
  mirror = await windowsMirror(inputs, input);
  const mainPort = await port();
  const rendererPort = await port();
  const appArguments = [
    `--inspect-brk=127.0.0.1:${mainPort}`,
    `--remote-debugging-port=${rendererPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--lang=en-US',
  ];
  const app = spawn(executable, appArguments, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = app;
  app.on('error', (error) => {
    evidence.launchError = String(error);
  });
  assert(app.pid);
  for (const stream of [app.stdout, app.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      log.write(chunk);
      process.stdout.write(chunk);
    });
  }
  const owner = await waitFor(
    async () => (await native.processes(executable)).find((item) => item.pid === app.pid) ?? null,
    'owned native Windows process'
  );
  assert.equal(owner.sid, session.sid);
  assert.equal(owner.session, session.session);
  owners.push(owner);
  evidence.process = owner;
  evidence.launchArguments = appArguments;
  const inspector = await waitFor(async () => {
    if (app.exitCode !== null) {
      throw new Error(`Official predecessor exited ${app.exitCode}`);
    }
    return (await targets(mainPort))?.find((item) => item.webSocketDebuggerUrl) ?? null;
  }, 'official Windows main inspector');
  main = await Cdp.connect(inspector.webSocketDebuggerUrl);
  await main.send('Debugger.enable');
  await main.send('Runtime.runIfWaitingForDebugger');
  const pause = await waitFor(
    () =>
      Promise.resolve(
        (main!.events.find((item) => item.method === 'Debugger.paused')?.params as
          | Pause
          | undefined) ?? null
      ),
    'official CJS entry pause'
  );
  const frame = pause.callFrames[0];
  assert(frame);
  const filename = await main.evaluate<string>('__filename', frame.callFrameId);
  assert(
    filename.replaceAll('\\', '/').endsWith('/resources/app.asar/dist-electron/main/index.cjs')
  );
  evidence.appEntry = filename;
  evidence.transportHook = await cdpCallFunction(
    main,
    `(()=>{const originalRequire=require;const getUpdater=()=>autoUpdater;return (origin,paths)=>{return (${cdpSerializedFunction(transportHook)})(originalRequire('electron'),getUpdater,origin,paths);};})()`,
    [mirror.origin, mirror.paths],
    frame.callFrameId
  );
  await main.send('Debugger.resume');
  const roots = await waitFor(async () => {
    const result = await state();
    return result.roots ? result : null;
  }, 'real Windows roots and bundled updater');
  assert.equal(roots.roots?.version, '2.17.1');
  assert.equal(roots.roots?.arch, process.arch);
  assert.equal(roots.roots?.packaged, true);
  assert(roots.roots);
  assert.equal(roots.roots.home.toLowerCase(), physical.home.toLowerCase());
  assert.equal(
    roots.roots.userData.toLowerCase(),
    path.join(physical.roaming, 'agent-teams-ai').toLowerCase()
  );
  assert.equal((await realpath(roots.roots.userData)).toLowerCase(), userData.toLowerCase());
  for (const entry of profile.links)
    assert.equal((await realpath(entry.link)).toLowerCase(), entry.target.toLowerCase());
  evidence.roots = roots.roots;
  assert.equal(roots.updater?.class, 'NsisUpdater');
  assert.deepEqual(roots.bound, ['default', 'electron-updater']);
  const page = await waitFor(
    async () =>
      (await targets(rendererPort))?.find(
        (item) => item.type === 'page' && item.url.startsWith('file:')
      ) ?? null,
    'official Windows renderer'
  );
  renderer = await Cdp.connect(page.webSocketDebuggerUrl);
  await renderer.send('Page.enable');
  await waitFor(
    () =>
      renderer!.evaluate<boolean | null>(
        '!document.getElementById("splash") && document.readyState === "complete" ? true : null'
      ),
    'real painted Windows desktop'
  );
  await waitFor(async () => {
    const result = await state();
    return result.updater?.provider === 'GitHubProvider' &&
      result.events.some((event) => event.type === 'available' && event.version === targetVersion)
      ? true
      : null;
  }, 'genuine Windows candidate');
  await waitFor(() => cdpBodyContains(renderer!, targetVersion), 'validated candidate reaches UI');
  const dialog = await renderer.evaluate<boolean>(
    'Boolean(document.querySelector("[role=dialog]"))'
  );
  if (!dialog) {
    await action('^(?:Update app|View details)$');
  }
  evidence.downloadButton = await action('^Download$', false);
  const text = await renderer.evaluate<string>('document.querySelector("[role=dialog]").innerText');
  assert(text.includes(targetVersion));
  evidence.availableDialog = text;
  await screenshot('available-renderer');
  const nativeDirectory = path.join(root, 'native-capture');
  await mkdir(nativeDirectory);
  const window = await waitFor(
    () => native.capture(owner, path.join(nativeDirectory, 'available-native.png')),
    'visible OS HWND belonging to official predecessor'
  );
  assert.equal(window.pid, owner.pid);
  assert.equal(window.foreground, true);
  assert(window.width >= 300 && window.height >= 200);
  const nativeImage = path.join(output, 'available-native.png');
  await copyFile(window.screenshot, nativeImage);
  assert((await stat(nativeImage)).size > 1000);
  evidence.nativeWindow = {
    ...window,
    screenshot: nativeImage,
    sha256: (await hashFile(nativeImage)).sha256,
  };
  const current = (await native.processes(executable)).find((item) => item.pid === owner.pid);
  assert.equal(current?.start, owner.start, 'Window PID identity changed');
  evidence.transport = await state();
  evidence.requests = mirror.requests;
  assert(
    mirror.requests.some(
      (request) =>
        request.session === 'electron-updater' &&
        request.path.endsWith('/latest.yml') &&
        request.status === 200
    )
  );
  assert(
    mirror.requests.some(
      (request) =>
        request.session === 'default' &&
        request.method === 'HEAD' &&
        request.path.endsWith(target.name) &&
        request.status === 200
    )
  );
  assert(
    mirror.requests.some(
      (request) =>
        request.session === 'default' &&
        request.path.includes(
          `/api/repos/777genius/agent-teams-ai/releases/tags/${inputs.target.tag_name}`
        ) &&
        request.status === 200
    )
  );
  assert.equal(
    mirror.requests.filter((request) => request.method === 'GET' && request.path.endsWith('.exe'))
      .length,
    0,
    'Feasibility must not invoke download/install'
  );
  assert(!logError);
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  evidence.failureUi = await renderer
    ?.evaluate(
      '({body:document.body.innerText,dialogs:[...document.querySelectorAll("[role=dialog]")].map(e=>e.innerText)})'
    )
    .catch(() => undefined);
  await screenshot('failure').catch(() => undefined);
} finally {
  main?.close();
  renderer?.close();
  const cleanup = await Promise.allSettled([
    (async () => {
      const discovered = await native.processes(executable);
      for (const owner of discovered) {
        assert(owner.executable.toLowerCase() === executable.toLowerCase());
      }
      await native.stop([...owners, ...discovered]);
      assert.equal(
        (await native.processes(executable)).length,
        0,
        'Owned app remains after cleanup'
      );
    })(),
    mirror?.close(),
  ]);
  evidence.cleanup = cleanup.map((result) =>
    result.status === 'fulfilled' ? result.value : String(result.reason)
  );
  if (child && cleanup[0]?.status === 'rejected') {
    // Ownership failed: release only this spawn's handles; retain its Firewall rules.
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    evidence.unresolvedLaunch = {
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      signalSent: false,
    };
  }
  // Keep app containment active until process cleanup completed.
  try {
    assert(
      cleanup[0]?.status === 'fulfilled',
      'Retain Firewall containment after failed process cleanup'
    );
    for (const setup of [
      priorInstaller,
      targetInstaller,
      ...(fixtureDecoder ? [fixtureDecoder] : []),
    ]) {
      await native.stop(await native.processes(setup));
      assert.equal((await native.processes(setup)).length, 0);
    }
    evidence.firewallRemoved = await native.removeFirewall(firewallGroup, firewallNames);
    assert.deepEqual(evidence.firewallRemoved, []);
    if (!(await absent(profileFile))) {
      const ownedProfile = JSON.parse(await readFile(profileFile, 'utf8')) as ProfileOwnership;
      assert.equal(ownedProfile.root, root);
      await releasePhysicalProfile(ownedProfile);
      evidence.profileReleased = true;
    }
  } catch (error) {
    evidence.firewallCleanupError = String(error);
    evidence.passed = false;
    process.exitCode = 1;
  }
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
    scope: evidence.scope,
    error: evidence.error,
    evidence: output,
  })
);
