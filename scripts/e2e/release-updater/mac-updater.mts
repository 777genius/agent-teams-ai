import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer as portServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadPlan } from '../../ci/release/assembly.ts';
import {
  canonical,
  digest,
  fileProof,
  requireThat,
  sameProof,
  version,
} from '../../ci/release/contract.ts';
import { readAsar, readInspectorFuse } from './archive.mts';
import { Cdp, waitFor } from './cdp.mts';
import {
  captureMacWindow,
  containMacNetwork,
  MacCommands,
  macLaunchOwner,
  macOwner,
  prepareMacWindow,
  recordMacLaunch,
  restoreMacNetwork,
  stopMacOwned,
} from './mac-loopback.mts';
import { readMacInputs } from './mac-inputs.mts';
import { macAbout, macAboutHasVersion, macAboutParagraphs } from './mac-old-ui.mts';
import { freshMacHome } from './mac-old-native.mts';
import { macReleaseMirror } from './mac-mirror.mts';
import { transportHook } from './transport.mts';
import { macCallFunction, macSerializedFunction } from './mac-serialization.mts';

import type { TransportState } from './transport.mts';
import type { App } from 'electron';

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
interface Pause {
  callFrames: { callFrameId: string }[];
}
interface Observation {
  events: { type: string; version?: string; message?: string }[];
  provider?: string;
  providerError?: string;
  candidateVersion?: string;
}
interface Observer {
  readonly clientPromise: Promise<{ constructor: { name: string } }> | null;
  on(event: string, listener: (info: { version?: string; message?: string }) => void): unknown;
}
// Observe the real singleton's lifecycle. No updater/provider/status/IPC is replaced.
function observeMac(app: App, getUpdater: () => Observer) {
  const state: Observation = { events: [] };
  (globalThis as typeof globalThis & { __TEST_macUpdater: Observation }).__TEST_macUpdater = state;
  app.once('ready', () => {
    const updater = getUpdater();
    for (const [event, type] of [
      ['checking-for-update', 'checking'],
      ['update-available', 'available'],
      ['update-not-available', 'not-available'],
      ['update-downloaded', 'downloaded'],
      ['download-progress', 'progress'],
      ['error', 'error'],
    ] as const)
      updater.on(event, (info) => {
        state.events.push({ type, version: info?.version, message: info?.message });
        if (type === 'not-available') state.candidateVersion = info?.version;
        // This existing promise resolves the original provider even on the no-update branch.
        // updateInfoAndProvider is deliberately left null by that branch in AppUpdater.
        void updater.clientPromise?.then(
          (provider) => {
            state.provider = provider.constructor.name;
          },
          (error: unknown) => {
            state.providerError = String(error);
          }
        );
      });
  });
}
const repository = '777genius/agent-teams-ai';
const sourceSha = '395572f9ff2a261cb28224754883a39d2c3c8827';
const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      [
        'plan',
        'plan-sha256',
        'input-digest',
        'tooling-sha',
        'architecture',
        'feed-mode',
        'inputs',
        'input-artifact-id',
        'input-artifact-sha256',
        'evidence',
      ].map((name) => [name, { type: 'string' as const }])
    ),
    'restore-network': { type: 'boolean' },
  },
  allowPositionals: false,
  strict: true,
});
function required(name: string) {
  const value: unknown = Reflect.get(values, name);
  requireThat(typeof value === 'string' && value.length > 0, `--${name} required`);
  return value;
}
const output = path.resolve(required('evidence'));
assert.equal(
  process.platform,
  'darwin',
  'Native Mac checks run only on disposable GitHub macOS VMs'
);
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, repository);
assert(
  process.env.GITHUB_WORKFLOW_REF?.startsWith(
    `${repository}/.github/workflows/updater-mac-updater.yml@`
  )
);
const runnerRoot = await realpath(process.env.RUNNER_TEMP ?? '');
assert(
  output.startsWith(`${runnerRoot}/TEST-mac-updater-`),
  'Evidence must be owned disposable TEST state'
);
await mkdir(output, { recursive: true });
const commands = new MacCommands(output);
if (values['restore-network']) {
  await restoreMacNetwork(commands);
  await writeFile(
    path.join(output, 'pf-emergency-restore.json'),
    JSON.stringify(commands.commands, null, 2)
  );
  process.exit(0);
}
const feedMode = required('feed-mode');
assert(feedMode === 'preview' || feedMode === 'staged');
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  scenario: 'mac-current-no-update',
  passed: false,
  currentVersion: '2.17.1',
  feedMode,
  finalPromotionFeed: false,
  planBindingVerified: false,
  expectedVersion: '2.17.1',
  scope:
    'native signed Mac 2.17.1 genuine no-update; older OTA and minimum-OS launch are not covered',
  commands: commands.commands,
};
let main: Cdp | undefined;
let renderer: Cdp | undefined;
let owner: Awaited<ReturnType<typeof macOwner>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
let installed: string | undefined;
let mirror: Awaited<ReturnType<typeof macReleaseMirror>> | undefined;
let networkOwned = false;
let log: ReturnType<typeof createWriteStream> | undefined;
let logError: Error | undefined;
let commonTag: string | undefined;
let commonVersion: string | undefined;
let phaseSequence = 0;
async function phase(label: string, state: 'START' | 'COMPLETE') {
  await writeFile(
    path.join(
      output,
      `${process.pid}-phase-${++phaseSequence}-${label}-${state.toLowerCase()}.json`
    ),
    `${canonical({ label, state, at: new Date().toISOString() })}\n`,
    { flag: 'wx', mode: 0o600 }
  ).catch(() => undefined);
}

async function freePort() {
  const server = portServer();
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
async function transport() {
  assert(main);
  const state = await main.evaluate<TransportState>('globalThis.__TEST_nativeUpdater');
  assert(!state.error, state.error);
  return state;
}
async function observation() {
  assert(main);
  return main.evaluate<Observation>('globalThis.__TEST_macUpdater');
}
async function screenshot(label: string) {
  if (!renderer) return;
  const image = await renderer.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  await writeFile(path.join(output, `${label}.png`), Buffer.from(image.data, 'base64'));
}
async function uiSnapshot() {
  assert(renderer);
  return renderer.evaluate<{
    body: string;
    dialogs: string[];
    buttons: { text: string; disabled: boolean; visible: boolean }[];
  }>(
    `({body:document.body.innerText,dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.textContent),buttons:[...document.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent.trim(),disabled:b.disabled,visible:Boolean(r.width&&r.height)}})})`
  );
}
async function clickButton(label: string, lookup: string) {
  assert(renderer);
  const point = await waitFor(
    () =>
      renderer!.evaluate<{ x: number; y: number; text: string } | null>(`(() => {
    const button=${lookup};
    if(!button||button.disabled)return null;button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;
    return r.width&&r.height&&button.contains(document.elementFromPoint(x,y))?{x,y,text:button.textContent.trim()}:null;
  })()`),
    `hit-tested ${label}`,
    15_000
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await renderer.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
  return point;
}
// The pinned 2.17.1 About block distinguishes the app updater from runtime/provider controls.
const aboutBlock = macAbout;
async function clickCheck() {
  const controls = [];
  controls.push(
    await clickButton(
      'More actions',
      'document.querySelector(\'button[aria-label="More actions"]\')'
    )
  );
  controls.push(
    await clickButton(
      'Settings menu item',
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Settings')"
    )
  );
  controls.push(
    await clickButton(
      'Advanced settings tab',
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Advanced')"
    )
  );
  evidence.aboutVersionParagraphs = await renderer?.evaluate(macAboutParagraphs);
  controls.push(
    await clickButton(
      'application About Check for Updates',
      `(() => {const block=${aboutBlock};if(!${macAboutHasVersion('2.17.1')})return null;return [...block.querySelectorAll('button')].find(b=>['Check for Updates','Up to date'].includes(b.textContent.trim()))??null;})()`
    )
  );
  return controls;
}
async function signature(app: string, architecture: string, label: string) {
  await commands.checked(`${label}-codesign`, '/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    app,
  ]);
  const identity = await commands.checked(`${label}-identity`, '/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    app,
  ]);
  assert(
    identity.stderr.includes('TeamIdentifier=6C84CW694S') &&
      identity.stderr.includes('Identifier=com.agent-teams.app')
  );
  const plist = path.join(app, 'Contents', 'Info.plist');
  for (const [key, expected] of [
    ['CFBundleShortVersionString', '2.17.1'],
    ['CFBundleIdentifier', 'com.agent-teams.app'],
    ['LSMinimumSystemVersion', '12.0'],
  ] as const)
    assert.equal(
      (
        await commands.checked(`${label}-${key.toLowerCase()}`, '/usr/libexec/PlistBuddy', [
          '-c',
          `Print :${key}`,
          plist,
        ])
      ).stdout.trim(),
      expected
    );
  for (const [name, binary] of [
    ['launcher', path.join(app, 'Contents', 'MacOS', 'Agent Teams AI')],
    [
      'framework',
      path.join(
        app,
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Electron Framework'
      ),
    ],
  ] as const)
    assert.equal(
      (
        await commands.checked(`${label}-arch-${name}`, '/usr/bin/lipo', ['-archs', binary])
      ).stdout.trim(),
      architecture === 'arm64' ? 'arm64' : 'x86_64'
    );
  return { teamIdentifier: '6C84CW694S', version: '2.17.1', architecture, productMinimum: '12.0' };
}

try {
  const toolingSha = required('tooling-sha');
  assert(/^[a-f0-9]{40}$/.test(toolingSha));
  assert.equal(process.env.GITHUB_SHA, toolingSha);
  assert.equal(
    (
      await commands.checked('tooling-checkout', '/usr/bin/git', ['rev-parse', 'HEAD'])
    ).stdout.trim(),
    toolingSha
  );
  const architecture = required('architecture');
  assert(architecture === 'arm64' || architecture === 'x64');
  assert.equal(process.arch, architecture);
  assert.equal(process.getuid?.() === 0, false, 'Aqua application must run unprivileged');
  const consoleUser = (
    await commands.checked('aqua-console-user', '/usr/bin/stat', ['-f', '%Su', '/dev/console'])
  ).stdout.trim();
  const user = (await commands.checked('runner-user', '/usr/bin/id', ['-un'])).stdout.trim();
  assert.equal(consoleUser, user, 'Use the existing ephemeral Aqua GUI account');
  evidence.testedOperatingSystem = (
    await commands.checked('tested-macos-version', '/usr/bin/sw_vers', ['-productVersion'])
  ).stdout.trim();
  assert(/^15\.\d+(?:\.\d+)?$/.test(String(evidence.testedOperatingSystem)));
  const plan = await loadPlan(required('plan'), required('plan-sha256'));
  assert.equal(digest(canonical(plan.input)), required('input-digest'));
  assert.equal(plan.input.toolingSha, toolingSha);
  assert.equal(plan.input.repository, repository);
  assert.equal(plan.input.mode, 'carry-mac');
  assert.equal(plan.input.macSource?.release.tag, 'v2.17.1');
  assert.equal(plan.input.macSource?.release.applicationSha, sourceSha);
  assert.equal(plan.input.target.tag, 'v2.17.5');
  commonTag = plan.input.target.tag;
  commonVersion = version(commonTag);
  evidence.previewCommonTag = commonTag;
  evidence.targetApplicationSha = plan.input.target.applicationSha;
  evidence.build = plan.input.build;
  assert(/^[a-f0-9]{40}$/.test(plan.input.target.applicationSha));
  const root = await mkdtemp(path.join(runnerRoot, 'TEST-mac-current-'));
  await phase('fresh-home', 'START');
  const profile = await freshMacHome(commands, 'updater-mac-updater');
  await phase('fresh-home', 'COMPLETE');
  const home = profile.home;
  const applications = path.join(root, 'Applications');
  const userData = path.join(root, 'user-data');
  const claude = path.join(home, '.claude');
  for (const directory of [
    home,
    userData,
    claude,
    applications,
    path.join(root, 'tmp'),
    path.join(home, '.codex'),
  ])
    await mkdir(directory, { recursive: true });
  await phase('input-qualification', 'START');
  const inputs = await readMacInputs(plan, required('inputs'), feedMode, architecture, evidence, {
    planSha256: required('plan-sha256'),
    inputDigest: required('input-digest'),
    toolingSha,
    artifactId: Number(required('input-artifact-id')),
    artifactSha256: required('input-artifact-sha256'),
  });
  await phase('input-qualification', 'COMPLETE');
  await phase('dmg-gatekeeper', 'START');
  const selected = inputs.files.get(inputs.names.dmg);
  assert(selected);
  const archive = selected.file;
  const mount = path.join(root, 'TEST-mount');
  await mkdir(mount);
  await commands.checked('dmg-verify', '/usr/bin/hdiutil', ['verify', archive]);
  await commands.checked('dmg-mount', '/usr/bin/hdiutil', [
    'attach',
    '-readonly',
    '-nobrowse',
    '-noautoopen',
    '-mountpoint',
    mount,
    archive,
  ]);
  installed = path.join(applications, 'Agent Teams AI.app');
  try {
    await commands.checked('install-unmodified-dmg-app', '/usr/bin/ditto', [
      path.join(mount, 'Agent Teams AI.app'),
      installed,
    ]);
  } finally {
    await commands.checked('detach-owned-dmg', '/usr/bin/hdiutil', ['detach', mount]);
  }
  evidence.signatureBefore = await signature(installed, architecture, 'before');
  await commands.checked('existing-app-ticket', '/usr/bin/xcrun', [
    'stapler',
    'validate',
    '-v',
    installed,
  ]);
  const gatekeeper = await commands.checked('real-online-gatekeeper', '/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    '--ignore-cache',
    '--no-cache',
    installed,
  ]);
  assert(gatekeeper.stderr.includes('source=Notarized Developer ID'));
  const resources = path.join(installed, 'Contents', 'Resources');
  const executable = path.join(installed, 'Contents', 'MacOS', 'Agent Teams AI');
  const framework = path.join(
    installed,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework'
  );
  evidence.fuse = await readInspectorFuse(framework);
  const asar = path.join(resources, 'app.asar');
  const asarBefore = await fileProof(asar, 'app.asar');
  const sources = await readAsar(asar, [
    'package.json',
    'dist-electron/main/index.cjs',
    'node_modules/electron-updater/out/AppUpdater.js',
    'node_modules/electron-updater/out/MacUpdater.js',
    'node_modules/electron-updater/out/providers/GitHubProvider.js',
    'node_modules/electron-updater/out/electronHttpExecutor.js',
  ]);
  const sourceLedger = [];
  for (const [name, bytes] of sources) {
    await writeFile(path.join(output, name.replaceAll('/', '__')), bytes);
    sourceLedger.push({ name, size: bytes.length, sha256: digest(bytes) });
  }
  evidence.sources = sourceLedger;
  evidence.appUpdateConfiguration = await readFile(path.join(resources, 'app-update.yml'), 'utf8');
  const packageBytes = sources.get('package.json');
  assert(packageBytes);
  assert.equal((JSON.parse(packageBytes.toString()) as { version: string }).version, '2.17.1');
  await phase('dmg-gatekeeper', 'COMPLETE');
  await phase('mirror-pf', 'START');
  const windowReader = await prepareMacWindow(commands);
  mirror = await macReleaseMirror(plan, inputs.source, inputs.files, inputs.feed, {
    rejectInstallerGet: true,
  });
  evidence.isolation = {
    ...profile,
    root,
    home,
    userData,
    claude,
    install: installed,
    guiAccount: user,
    freshEphemeralGuiAccount: true,
  };
  networkOwned = true;
  evidence.network = await containMacNetwork(commands, installed);
  const loopback = await fetch(
    `${mirror.origin}/github/${repository}/releases/download/${commonTag}/latest-mac.yml`,
    { signal: AbortSignal.timeout(30_000) }
  );
  assert(loopback.ok);
  assert.equal(await loopback.text(), plan.feeds['latest-mac.yml']);
  await phase('mirror-pf', 'COMPLETE');
  await phase('spawn-cdp', 'START');
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'production',
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
  evidence.childEnvironmentKeys = Object.keys(env);
  const mainPort = await freePort();
  const rendererPort = await freePort();
  log = createWriteStream(path.join(output, 'desktop.log'));
  log.on('error', (error) => {
    logError = error;
  });
  // Persist the attempt before spawn so interrupted registration stays fail-closed.
  await recordMacLaunch(commands);
  const app = spawn(
    executable,
    [
      `--inspect-brk=127.0.0.1:${mainPort}`,
      `--remote-debugging-port=${rendererPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userData}`,
      '--lang=en-US',
    ],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  // Retain the actual spawn handle before any fallible kernel ownership lookup.
  child = app;
  let launchError: Error | undefined;
  app.on('error', (error) => {
    launchError = error;
  });
  assert(app.pid);
  await recordMacLaunch(commands, app.pid);
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (bytes: Buffer) => log?.write(bytes));
  owner = await macLaunchOwner(commands, app, app.pid, executable);
  await recordMacLaunch(commands, app.pid, owner);
  const inspector = await waitFor(
    async () => {
      if (launchError) throw launchError;
      assert.equal(app.exitCode, null, 'Official signed Mac app exited');
      return (await targets(mainPort))?.find((target) => target.webSocketDebuggerUrl) ?? null;
    },
    'unmodified signed packaged Mac main inspector',
    15_000
  );
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
    'original Mac CJS app entry pause',
    15_000
  );
  const frame = paused.callFrames[0];
  assert(frame);
  const entry = await main.evaluate<string>('__filename', frame.callFrameId);
  assert.equal(entry, path.join(resources, 'app.asar', 'dist-electron/main/index.cjs'));
  const mainHome = await macCallFunction<{
    environment: string;
    node: string;
    account: string;
  }>(
    main,
    '(()=>{const os=require("node:os");return ()=>({environment:process.env.HOME,node:os.homedir(),account:os.userInfo().homedir});})()',
    [],
    frame.callFrameId
  );
  evidence.mainHome = mainHome;
  assert(mainHome, 'Actual signed Mac main home observation required');
  for (const field of ['environment', 'node', 'account'] as const)
    assert.equal(mainHome[field], home);
  await macCallFunction(
    main,
    `(()=>{const originalRequire=require;const getUpdater=()=>autoUpdater;return (origin,paths)=>{(${macSerializedFunction(transportHook)})(originalRequire('electron'),getUpdater,origin,paths);(${macSerializedFunction(observeMac)})(originalRequire('electron').app,getUpdater);};})()`,
    [mirror.origin, mirror.paths],
    frame.callFrameId
  );
  await main.send('Debugger.resume');
  const bound = await waitFor(
    async () => {
      const state = await transport();
      return state.roots ? state : null;
    },
    'early native Mac roots and both transport sessions',
    30_000
  );
  assert.deepEqual(bound.bound, ['default', 'electron-updater']);
  assert.equal(bound.updater?.class, 'MacUpdater');
  assert.equal(bound.roots?.version, '2.17.1');
  assert.equal(bound.roots?.arch, architecture);
  assert.equal(bound.roots?.packaged, true);
  assert.equal(bound.roots?.userData, userData);
  assert.equal(bound.roots?.home, home);
  assert.equal(bound.roots?.executable, executable);
  assert.equal(bound.roots?.resources, resources);
  evidence.roots = bound.roots;
  evidence.entry = entry;
  const page = await waitFor(
    async () =>
      (await targets(rendererPort))?.find(
        (target) => target.type === 'page' && target.url.startsWith('file:')
      ) ?? null,
    'native Mac renderer CDP',
    30_000
  );
  renderer = await Cdp.connect(page.webSocketDebuggerUrl);
  await renderer.send('Page.enable');
  await waitFor(
    () =>
      renderer!.evaluate<boolean | null>(
        '!document.getElementById("splash") && document.readyState === "complete" ? true : null'
      ),
    'rendered Mac desktop',
    45_000
  );
  await phase('spawn-cdp', 'COMPLETE');
  await phase('no-update-capture', 'START');
  const startup = await waitFor(
    async () => {
      const state = await observation();
      assert(!state.events.some((event) => event.type === 'error' || event.type === 'available'));
      assert(!state.providerError, state.providerError);
      return state.events.some(
        (event) => event.type === 'not-available' && event.version === '2.17.1'
      )
        ? state
        : null;
    },
    'genuine startup no-update from the frozen common target preview',
    30_000
  );
  evidence.startup = startup;
  const beforeChecks = startup.events.filter((event) => event.type === 'checking').length;
  evidence.checkControl = await clickCheck();
  const checked = await waitFor(
    async () => {
      const state = await observation();
      assert(
        !state.events.some((event) =>
          ['error', 'available', 'downloaded', 'progress'].includes(event.type)
        )
      );
      assert(!state.providerError, state.providerError);
      return state.provider &&
        state.events.filter((event) => event.type === 'checking').length > beforeChecks &&
        state.events.filter((event) => event.type === 'not-available').length >
          startup.events.filter((event) => event.type === 'not-available').length
        ? state
        : null;
    },
    'real UI-triggered check completes not-available',
    30_000
  );
  assert.equal(checked.provider, 'GitHubProvider');
  assert.equal(checked.candidateVersion, '2.17.1');
  assert(renderer);
  evidence.renderedNoUpdate = await waitFor(
    () =>
      renderer!.evaluate<string | null>(
        `(() => {const block=${aboutBlock};return block&&[...block.querySelectorAll('button')].some(b=>b.textContent.trim()==='Up to date')?block.innerText:null;})()`
      ),
    'rendered application About Up to date state',
    5000
  );
  const ui = await uiSnapshot();
  assert(
    !ui.body.includes(commonVersion),
    'Current Mac UI must not promise the common target version'
  );
  assert(!ui.dialogs.some((dialog) => /download|restart|install update/i.test(dialog)));
  assert(
    !ui.buttons.some(
      (button) => button.visible && /^(Download|Restart.*update|Install update)$/i.test(button.text)
    )
  );
  for (const suffix of ['/releases.atom', '/releases/latest', `/${commonTag}/latest-mac.yml`])
    assert(
      mirror.requests.some(
        (request) =>
          request.session === 'electron-updater' &&
          request.method === 'GET' &&
          request.status === 200 &&
          request.path.endsWith(suffix)
      ),
      `Real GitHubProvider GET required: ${suffix}`
    );
  const state = await transport();
  assert(
    !state.requests.some(
      (request) => request.method === 'GET' && /\.(zip|dmg)(\?|$)/.test(request.url)
    ),
    'No installer GET may be attempted'
  );
  assert(
    !mirror.requests.some(
      (request) => request.method === 'GET' && /\.(zip|dmg)$/.test(request.path)
    )
  );
  await screenshot('no-update-renderer');
  evidence.nativeWindow = await captureMacWindow(commands, windowReader, owner, installed);
  evidence.ui = ui;
  evidence.observation = checked;
  evidence.transport = state;
  evidence.signatureAfter = await signature(installed, architecture, 'after');
  sameProof(await fileProof(asar, 'app.asar'), asarBefore);
  assert(!logError, 'Desktop log stream failed');
  await phase('no-update-capture', 'COMPLETE');
  evidence.passed = true;
} catch (error) {
  evidence.failureAboutVersionParagraphs = await renderer
    ?.evaluate(macAboutParagraphs)
    .catch(() => null);
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  evidence.transport = await transport().catch(() => undefined);
  evidence.observation = await observation().catch(() => undefined);
  await screenshot('failure-renderer').catch(() => undefined);
} finally {
  await phase('cleanup', 'START');
  if (child && !owner) {
    // No signal is safe without PID/group proof. Release only our pipes and child handle.
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    evidence.unresolvedLaunch = {
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      signalSent: false,
    };
    evidence.cleanupError = 'Spawned launch ownership remains unresolved; no signals sent';
    evidence.passed = false;
    process.exitCode = 1;
  }
  const controls = await Promise.allSettled([
    Promise.resolve().then(() => main?.close()),
    Promise.resolve().then(() => renderer?.close()),
    owner && installed ? stopMacOwned(commands, owner, installed) : Promise.resolve(null),
  ]);
  evidence.cleanup = controls.map((result) =>
    result.status === 'fulfilled' ? result.value : String(result.reason)
  );
  if (controls.some((result) => result.status === 'rejected')) {
    evidence.passed = false;
    process.exitCode = 1;
  }
  if (networkOwned) {
    try {
      await access(path.join(output, 'pf-owned.json'));
      evidence.networkRestore = await restoreMacNetwork(commands);
    } catch (error) {
      evidence.networkRestoreError = String(error);
      evidence.passed = false;
      process.exitCode = 1;
    }
  }
  const resources = await Promise.allSettled([
    mirror?.close(),
    new Promise<void>((resolve) => {
      if (!log || log.destroyed) resolve();
      else log.end(resolve);
    }),
  ]);
  if (resources.some((result) => result.status === 'rejected') || logError) {
    evidence.passed = false;
    process.exitCode = 1;
  }
  await phase('cleanup', 'COMPLETE');
  evidence.requests = mirror?.requests ?? [];
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(output, 'mac-current-no-update.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  );
}
process.stdout.write(
  `${JSON.stringify({ passed: evidence.passed, scenario: evidence.scenario, error: evidence.error })}\n`
);
