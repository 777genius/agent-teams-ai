import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { hashFile, stageArguments } from './inputs.mts';
import { Cdp, waitFor } from './cdp.mts';
import {
  cdpCallFunction,
  cdpSerializedFunction,
  cdpBodyContains,
  cdpButtonPoint,
} from './cdp-values.mts';
import { packageCases, packageInputs, packageKind, packageName } from './linux-packages-inputs.mts';
import { packageMirror } from './linux-packages-mirror.mts';
import {
  desktopProof,
  installedProof,
  lateWindowObservation,
  observePackage,
  ownedPackageApps,
  rendererSandbox,
} from './linux-packages-native.mts';
import { processIdentity, stopOwnedGroup } from './native-window.mts';
import { transportHook } from './transport.mts';
import {
  automaticLaunchSeal,
  packageLaunchSeal,
  packagePausedEntry as pausedEntry,
  resumeSealedInspector,
  sealedKernelProof,
} from './linux-packages-seal.mts';

import type {
  Identity,
  PackageUpdateEvent as UpdateEvent,
  WindowProcess,
} from './linux-packages-native.mts';
import type { TransportState } from './transport.mts';
import type { ButtonScope } from './cdp-values.mts';
import type { AutomaticLaunchSeal, RuntimeLaunch } from './linux-packages-seal.mts';

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
const args = process.argv.slice(2);
function value(name: string) {
  const index = args.indexOf(name);
  const result = args[index + 1];
  assert(index >= 0 && result, `Required ${name}`);
  return result;
}
const kind = packageKind(value('--kind'));
const mode = value('--mode');
assert(['availability', 'ota', 'fresh'].includes(mode));
const input = path.resolve(value('--inputs'));
const output = path.resolve(value('--evidence'));
const references = path.resolve(value('--references'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), `TEST-linux-${kind}-`));
const home = path.join(root, 'home');
const userData = path.join(root, 'user-data');
const claude = path.join(home, '.claude');
const evidence: Record<string, unknown> = {
  scope: `Linux ${kind} ${mode}`,
  mode,
  passed: false,
  automaticSuccessorProved: false,
  diagnosticRelaunch: false,
  installAttempted: false,
  startedAt: new Date().toISOString(),
};
const owners = new Map<number, Identity>();
const children: ReturnType<typeof spawn>[] = [];
let targetVersion = '';
let targetTag = '';
let targetSize = 0;
let minimumStart: string | undefined;
let executable: string | undefined;
let main: Cdp | undefined;
let renderer: Cdp | undefined;
let mirror: Awaited<ReturnType<typeof packageMirror>> | undefined;
let logError: Error | undefined;
const log = createWriteStream(path.join(output, 'desktop.log'));
log.on('error', (error) => {
  logError = error;
});
const execute = promisify(execFile);
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
async function targets(endpoint: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint}/json/list`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok ? ((await response.json()) as Target[]) : null;
  } catch {
    return null;
  }
}
async function state() {
  assert(main);
  const result = await main.evaluate<TransportState>('globalThis.__TEST_nativeUpdater');
  if (result?.error) throw new Error(result.error);
  return result;
}
async function events() {
  assert(main);
  return main.evaluate<UpdateEvent[]>('globalThis.__TEST_packageEvents');
}
async function point(pattern: string, scope: ButtonScope = 'document') {
  assert(renderer);
  return cdpButtonPoint(renderer, pattern, scope);
}
async function click(pattern: string, scope?: ButtonScope) {
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
async function ui() {
  assert(renderer);
  return renderer.evaluate(
    '({url:location.href,body:document.body.innerText.slice(0,30000),buttons:[...document.querySelectorAll("button")].map(b=>({text:b.textContent,disabled:b.disabled}))})'
  );
}
async function config() {
  return JSON.parse(await readFile(path.join(claude, 'agent-teams-config.json'), 'utf8')) as {
    general: { theme: string };
  };
}
function transportRoutes(download: boolean, start = 0) {
  assert(mirror);
  const requests = mirror.requests.slice(start);
  for (const route of [
    '/github/777genius/agent-teams-ai/releases.atom',
    '/github/777genius/agent-teams-ai/releases/latest',
    `/github/777genius/agent-teams-ai/releases/download/${targetTag}/latest-linux.yml`,
  ])
    assert(
      requests.some(
        (request) =>
          request.path === route &&
          request.method === 'GET' &&
          request.session === 'electron-updater' &&
          request.status === 200
      ),
      `Genuine provider request missing: ${route}`
    );
  if (!download) return;
  assert(
    requests.some(
      (request) =>
        request.path === `/api/repos/777genius/agent-teams-ai/releases/tags/${targetTag}` &&
        request.method === 'GET' &&
        request.session === 'default' &&
        request.status === 200
    )
  );
  assert(
    requests.some(
      (request) =>
        request.path.endsWith(`/Agent.Teams.AI-${targetVersion}.AppImage`) &&
        request.method === 'HEAD' &&
        request.session === 'default' &&
        request.status === 200
    )
  );
  assert(targetSize > 0);
  assert(
    requests.some(
      (request) =>
        request.path === mirror?.installer &&
        request.method === 'GET' &&
        request.session === 'electron-updater' &&
        request.status === 200 &&
        request.transferred === targetSize
    ),
    'Complete real native package download missing'
  );
}
const env: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
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
    // Only ENOENT returns null; permission/ownership failures propagate.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Cannot prove live ownership of spawned PID ${pid}`);
}
async function launch(version: string) {
  assert(executable && mirror);
  const inspectorPort = await port();
  const rendererPort = await port();
  const app = spawn(
    executable,
    [
      `--inspect-brk=127.0.0.1:${inspectorPort}`,
      `--remote-debugging-port=${rendererPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--lang=en-US',
      `--user-data-dir=${userData}`,
    ],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(app);
  app.on('error', (error) => {
    evidence.launchError = String(error);
  });
  assert(app.pid);
  const pid = app.pid;
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => {
      log.write(chunk);
      process.stdout.write(chunk);
    });
  const owner = await launchIdentity(app, pid);
  owners.set(owner.group, owner);
  minimumStart ??= owner.start;
  const inspector = await waitFor(async () => {
    if (app.exitCode !== null) throw new Error(`Official app exited ${app.exitCode}`);
    return (await targets(inspectorPort))?.find((target) => target.webSocketDebuggerUrl) ?? null;
  }, 'native package main inspector');
  main = await Cdp.connect(inspector.webSocketDebuggerUrl);
  const entry = await pausedEntry(main, pid);
  await cdpCallFunction(
    main,
    `(()=>{const originalRequire=require;const getUpdater=()=>autoUpdater;return (origin,paths)=>{(${cdpSerializedFunction(transportHook)})(originalRequire('electron'),getUpdater,origin,paths);(${cdpSerializedFunction(observePackage)} )(originalRequire('electron'),getUpdater);};})()`,
    [mirror.origin, mirror.paths],
    entry.frame.callFrameId
  );
  await main.send('Debugger.resume');
  const roots = await waitFor(async () => {
    const candidate = await state();
    return candidate.roots ? candidate : null;
  }, 'packaged singleton and effective transport hooks');
  assert.equal(roots.roots?.version, version);
  assert.equal(roots.roots?.executable, executable);
  assert.equal(roots.roots?.resources, path.join(path.dirname(executable), 'resources'));
  assert.equal(roots.roots?.home, home);
  assert.equal(roots.roots?.userData, userData);
  assert.equal(roots.roots?.packaged, true);
  assert.equal(roots.roots?.arch, 'x64');
  assert.equal(roots.roots?.appImage, '');
  assert.equal(roots.updater?.class, packageCases[kind].updater);
  assert.deepEqual(roots.bound, ['default', 'electron-updater']);
  assert.equal(await readlink(`/proc/${pid}/ns/net`), await readlink('/proc/self/ns/net'));
  const page = await waitFor(
    async () =>
      (await targets(rendererPort))?.find(
        (target) => target.type === 'page' && target.url.startsWith('file:')
      ) ?? null,
    'real desktop renderer'
  );
  renderer = await Cdp.connect(page.webSocketDebuggerUrl);
  await renderer.send('Page.enable');
  await waitFor(() => {
    assert(renderer);
    return renderer.evaluate<boolean | null>(
      '!document.getElementById("splash")&&document.readyState==="complete"?true:null'
    );
  }, 'painted packaged desktop');
  const prefs = await main.evaluate<WindowProcess[]>('globalThis.__TEST_packagePreferences()');
  assert(
    prefs.length && prefs.every((pref) => pref.sandbox === true),
    'Effective Electron renderer sandbox must be enabled'
  );
  const applications = await ownedPackageApps(executable, { home, userData }, owner.start);
  const currentApp = applications.find((candidate) => candidate.pid === pid);
  assert(currentApp);
  return {
    identity: owner,
    entry,
    transport: roots,
    process: currentApp,
    preferences: prefs,
    inspectorPort,
    rendererPort,
  };
}
function releaseConnections() {
  main?.close();
  renderer?.close();
  main = undefined;
  renderer = undefined;
}
async function nativeDesktop(candidate: Identity, label: string, seal?: AutomaticLaunchSeal) {
  const group = owners.get(candidate.group) ?? (seal ? candidate : undefined);
  assert(group, 'Native capture requires owned launch or sealed read-only candidate');
  if (seal) await sealedKernelProof(candidate, seal);
  const result = await desktopProof(group, path.join(output, label), candidate);
  assert.equal(
    result.identity.pid,
    candidate.pid,
    'OS native window must belong to exact installed main PID'
  );
  if (main) {
    const windows = await main.evaluate<WindowProcess[]>('globalThis.__TEST_packagePreferences()');
    const sandbox = await rendererSandbox(group, candidate, windows);
    assert.deepEqual(
      await main.evaluate('globalThis.__TEST_packagePreferences()'),
      windows,
      'Actual Electron window association changed during kernel proof'
    );
    return { ...result, sandbox };
  }
  assert(executable && evidence.automaticPackage && evidence.profileAfterAutomatic);
  evidence.automaticNativeBeforeInspector = {
    process: candidate,
    desktop: result,
    profile: evidence.profileAfterAutomatic,
    version: targetVersion,
    capturedAt: new Date().toISOString(),
  };
  const read = await lateWindowObservation(group, candidate, {
    executable,
    version: targetVersion,
    resources: path.join(path.dirname(executable), 'resources'),
    userData,
    seal: seal?.launch,
  });
  evidence.automaticReadOnlyInspector = read;
  return { ...result, sandbox: read.sandbox };
}

try {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert(process.getuid?.() !== 0, 'No root GUI');
  await access('/.dockerenv');
  assert(process.env.DISPLAY && process.env.XAUTHORITY, 'Private authenticated Xvfb required');
  const interfaces = os.networkInterfaces();
  assert.deepEqual(Object.keys(interfaces), ['lo']);
  assert(
    Object.values(interfaces)
      .flat()
      .every((address) => address?.internal)
  );
  const status = await readFile('/proc/self/status', 'utf8');
  assert(/^Seccomp:\s+2$/m.test(status), 'Disposable container must retain seccomp filtering');
  evidence.container = {
    uid: process.getuid?.(),
    osRelease: await readFile('/etc/os-release', 'utf8'),
    netNamespace: await readlink('/proc/self/ns/net'),
    security: status.split('\n').filter((line) => /^Seccomp|^Cap|^NoNewPrivs/.test(line)),
    profile: JSON.parse(await readFile('/TEST-container-security.json', 'utf8')) as unknown,
    apparmor: await readFile('/proc/self/attr/current', 'utf8'),
  };
  assert(
    new RegExp({ deb: '^ID=ubuntu$', rpm: '^ID=fedora$', pacman: '^ID=arch$' }[kind], 'm').test(
      String((evidence.container as { osRelease: string }).osRelease)
    ),
    'Actual distribution must match native package manager case'
  );
  // A failed unprivileged user namespace is a concrete unmet sandbox gate.
  evidence.userNamespace = await execute('/usr/bin/unshare', ['-Ur', 'true'], {
    env: { PATH: '/usr/bin:/bin' },
    timeout: 5000,
  });
  const inputs = await packageInputs(
    input,
    stageArguments(args),
    args.includes('--historical-preview')
  );
  targetVersion = inputs.targetVersion;
  targetTag = inputs.targetTag;
  const target = inputs.verified.find((item) => item.name === packageName(kind, targetVersion));
  assert(target);
  targetSize = target.size;
  evidence.targetVersion = targetVersion;
  evidence.historicalPreview = !inputs.binding.manifestBound;
  evidence.inputs = inputs.verified;
  evidence.binding = inputs.binding;
  evidence.manifestBoundInputs = inputs.binding.manifestBound;
  evidence.finalReleaseAcceptance = false;
  await writeFile(path.join(output, 'latest-linux.yml'), inputs.feed);
  for (const directory of [
    home,
    userData,
    claude,
    path.join(root, 'tmp'),
    path.join(home, '.config'),
    path.join(home, '.cache'),
    path.join(home, '.local/share'),
  ])
    await mkdir(directory, { recursive: true });
  evidence.isolation = {
    root,
    home,
    userData,
    claude,
    environmentKeys: Object.keys(env),
    network: 'loopback-only across install/relaunch',
    credentialValuesInherited: false,
  };
  const initialVersion = mode === 'fresh' ? targetVersion : '2.17.1';
  const prior = await installedProof(
    kind,
    initialVersion,
    references,
    path.join(output, 'initial-source')
  );
  executable = prior.database.executable;
  evidence.initialPackage = prior;
  mirror = await packageMirror(inputs, input, kind);
  const initial = await launch(initialVersion);
  evidence.initialLaunch = initial;
  if (mode === 'fresh') {
    await waitFor(
      async () =>
        (await events()).some(
          (event) => event.type === 'update-not-available' && event.version === targetVersion
        )
          ? true
          : null,
      'fresh target genuine no-update'
    );
    transportRoutes(false);
    evidence.freshDesktop = await nativeDesktop(initial.identity, 'fresh-desktop');
    assert(
      !mirror.requests.some(
        (request) => request.method === 'GET' && request.path === mirror?.installer
      )
    );
    evidence.postUpdate = { events: await events(), state: await state(), noInstallerGet: true };
  } else {
    await waitFor(async () => {
      const update = await state();
      return update.updater?.provider === 'GitHubProvider' &&
        update.events.some((event) => event.type === 'available' && event.version === targetVersion)
        ? true
        : null;
    }, `genuine native updater available ${targetVersion}`);
    await waitFor(() => {
      assert(renderer);
      return cdpBodyContains(renderer, targetVersion);
    }, 'normal UI validated availability');
    const dialog: ButtonScope = 'dialog';
    if (mode === 'availability') {
      if (!(await point('^Download$', dialog))) await click('^(?:View details|Update app)$');
      await waitFor(() => point('^Download$', dialog), 'hit-tested real available dialog');
      await screenshot('available');
      evidence.availableUi = await ui();
      evidence.transport = await state();
      transportRoutes(false);
      const requests = mirror.requests;
      assert(
        requests.some(
          (request) =>
            request.session === 'default' &&
            request.method === 'HEAD' &&
            request.path.endsWith('.AppImage') &&
            request.status === 200
        )
      );
      evidence.availableWindow = await nativeDesktop(initial.identity, 'available-desktop');
    } else {
      if (await point('^Later$', dialog)) await click('^Later$', dialog);
      await waitFor(() => {
        assert(renderer);
        return renderer.evaluate<boolean | null>(
          'document.querySelector("[role=dialog]")?null:true'
        );
      }, 'updater modal dismissed before Settings');
      assert(renderer);
      for (const type of ['keyDown', 'keyUp'])
        await renderer.send('Input.dispatchKeyEvent', {
          type,
          key: ',',
          code: 'Comma',
          modifiers: 2,
        });
      await click('^Light$');
      await waitFor(async () => {
        try {
          return (await config()).general.theme === 'light' ? true : null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }, 'actual TEST preference persisted');
      evidence.profileBefore = await config();
      await screenshot('profile-before');
      await click('^Advanced$');
      if (!(await point('^Download$', dialog))) await click('^(?:Update app|View details)$');
      await waitFor(() => point('^Download$', dialog), 'real download dialog');
      await screenshot('available');
      evidence.downloadAction = await click('^Download$', dialog);
      await waitFor(
        async () =>
          (await events()).some(
            (event) =>
              event.type === 'download-progress' &&
              (event.percent ?? 0) > 0 &&
              (event.percent ?? 100) < 100
          )
            ? true
            : null,
        'real native package progress',
        120_000
      );
      evidence.progressUi = await waitFor(() => {
        assert(renderer);
        return renderer.evaluate<string | null>(
          '(() => {const b=[...document.querySelectorAll("button")].find(b=>/\\d+%/.test(b.textContent));if(!b)return null;const r=b.getBoundingClientRect();return r.width&&r.height?b.textContent.trim():null})()'
        );
      }, 'visible genuine progress');
      await screenshot('progress');
      await waitFor(
        async () =>
          (await events()).some(
            (event) => event.type === 'update-downloaded' && event.version === targetVersion
          )
            ? true
            : null,
        'real target package downloaded',
        180_000
      );
      if (!(await point('^Restart now$', dialog)))
        await click('^(?:Restart to update|View details)$');
      await waitFor(() => point('^Restart now$', dialog), 'actionable real Restart now');
      await screenshot('downloaded');
      evidence.updaterEvents = await events();
      evidence.transport = await state();
      transportRoutes(true);
      assert(minimumStart);
      const before = new Set(
        (await ownedPackageApps(executable, { home, userData }, minimumStart)).map((app) => app.pid)
      );
      assert(main);
      const runtime = await main.evaluate<RuntimeLaunch>(
        '({pid:process.pid,argv:process.argv,execArgv:process.execArgv,home:process.env.HOME,profile:process.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR,versions:{electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node}})'
      );
      const launchSeal = packageLaunchSeal(initial.process.command, runtime, {
        executable,
        home,
        userData,
        inspectorPort: initial.inspectorPort,
        rendererPort: initial.rendererPort,
      });
      const seal = await automaticLaunchSeal(
        initial.identity,
        [...before],
        launchSeal,
        await hashFile(path.join(references, targetVersion, path.relative('/', executable)))
      );
      evidence.automaticLaunchSeal = seal;
      const candidates: Record<string, unknown>[] = [];
      const seenCandidates = new Set<string>();
      evidence.automaticSelection = {
        original: initial.identity,
        minimumStart,
        before: [...before],
      };
      evidence.automaticCandidates = candidates;
      evidence.installAttempted = true;
      evidence.installAction = await click('^Restart now$', dialog);
      releaseConnections();
      const successor = await waitFor(
        async () => {
          assert(executable && minimumStart);
          return (
            (
              await ownedPackageApps(
                executable,
                { home, userData },
                minimumStart,
                (candidate) => {
                  const snapshot = { ...candidate, newPid: !before.has(candidate.pid) };
                  const key = JSON.stringify(snapshot);
                  if (!seenCandidates.has(key)) {
                    seenCandidates.add(key);
                    candidates.push({ observedAt: new Date().toISOString(), ...snapshot });
                  }
                },
                seal
              )
            ).find((app) => !before.has(app.pid)) ?? null
          );
        },
        'updater-created automatic package successor',
        90_000
      );
      assert.equal(
        await readlink(`/proc/${successor.pid}/ns/net`),
        await readlink('/proc/self/ns/net')
      );
      assert.equal(
        successor.executable,
        executable,
        'Automatic successor must run current installed inode, never a deleted prior executable'
      );
      evidence.automaticProcess = successor;
      // Electron app.relaunch can preserve inspect-brk arguments. Resume only
      // this updater-created PID; never manually spawn it before native proof.
      evidence.automaticEntry = await resumeSealedInspector(successor, seal);
      evidence.automaticPackage = await installedProof(
        kind,
        targetVersion,
        references,
        path.join(output, 'automatic-source')
      );
      const installed = evidence.automaticPackage as Awaited<ReturnType<typeof installedProof>>;
      const expected = installed.payload.find((item) => item.relative === 'agent-teams-ai');
      assert(expected);
      const processPayload = await hashFile(`/proc/${successor.pid}/exe`);
      assert.equal(processPayload.sha256, expected.sha256);
      evidence.automaticProcessPayload = {
        ...processPayload,
        maps: await readFile(`/proc/${successor.pid}/maps`, 'utf8'),
      };
      assert.equal((await config()).general.theme, 'light');
      evidence.profileAfterAutomatic = await config();
      evidence.automaticDesktop = await nativeDesktop(successor, 'automatic-desktop', seal);
      evidence.automaticSealAfterPaint = await sealedKernelProof(successor, seal);
      const current = await processIdentity(successor.pid);
      assert.equal(current?.start, successor.start);
      assert.equal((await config()).general.theme, 'light');
      owners.set(successor.group, successor);
      evidence.automaticSuccessorProved = true;
      evidence.automaticProofAt = new Date().toISOString();
      const groupOwner = owners.get(successor.group);
      assert(groupOwner);
      evidence.automaticStop = await stopOwnedGroup(groupOwner);
      evidence.diagnosticRelaunch = true;
      const requestStart = mirror.requests.length;
      evidence.diagnostic = await launch(targetVersion);
      await waitFor(
        async () =>
          (await events()).some(
            (event) => event.type === 'update-not-available' && event.version === targetVersion
          )
            ? true
            : null,
        'installed target genuine no-update'
      );
      transportRoutes(false, requestStart);
      assert(
        !mirror.requests
          .slice(requestStart)
          .some((request) => request.method === 'GET' && request.path === mirror?.installer)
      );
      assert.equal((await config()).general.theme, 'light');
      assert(renderer);
      assert(
        await renderer.evaluate<boolean>('document.documentElement.classList.contains("light")')
      );
      evidence.postUpdate = {
        events: await events(),
        state: await state(),
        noInstallerGet: true,
        preference: 'light',
      };
      await screenshot('post-update');
    }
  }
  assert(!logError);
  evidence.sandboxEnabled = true;
  evidence.stageBoundScenarioProved =
    (mode === 'ota' || mode === 'fresh') && inputs.binding.manifestBound;
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.failureUi = await ui().catch(() => undefined);
  evidence.lastTransport = await state().catch(() => undefined);
  await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  try {
    if (executable && minimumStart)
      for (const app of await ownedPackageApps(executable, { home, userData }, minimumStart))
        if (app.group === app.pid) owners.set(app.group, app);
  } catch (error) {
    evidence.cleanupDiscoveryError = String(error);
    evidence.passed = false;
    process.exitCode = 1;
  }
  const unresolved = children.filter(
    (child) => child.pid && ![...owners.values()].some((owner) => owner.pid === child.pid)
  );
  evidence.unresolvedLaunches = unresolved.map((child) => ({ pid: child.pid, signalSent: false }));
  if (unresolved.length) {
    evidence.passed = false;
    process.exitCode = 1;
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => releaseConnections()),
    ...[...owners.values()].map((owner) => stopOwnedGroup(owner)),
    mirror?.close(),
  ]);
  // Even failed owned-group cleanup must not keep this harness alive through
  // our retained pipes/handles. Release only our handles, without new signals.
  for (const child of children) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  evidence.cleanup = cleanup.map((result) =>
    result.status === 'fulfilled' ? result.value : String(result.reason)
  );
  if (cleanup.some((result) => result.status === 'rejected') || logError) {
    evidence.passed = false;
    process.exitCode = 1;
  }
  try {
    await new Promise<void>((resolve, reject) =>
      log.end(() => (logError ? reject(logError) : resolve()))
    );
  } catch (error) {
    evidence.logError = String(error);
    evidence.passed = false;
    process.exitCode = 1;
  }
  evidence.requests = mirror?.requests;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
