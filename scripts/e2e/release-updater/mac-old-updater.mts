import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
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
import {
  captureOldMacSources,
  coldMacUpdaterCache,
  oldMacInstaller,
  readMacInputs,
  sourceMacPin,
  sourceSha,
} from './mac-inputs.mts';
import { Cdp, waitFor } from './cdp.mts';
import { MacCommands, macLaunchOwner } from './mac-loopback.mts';
import { macReleaseMirror } from './mac-mirror.mts';
import {
  automaticMacApp,
  containOldMacNetwork,
  freshMacHome,
  macBundleSignature,
  macDmgInstall,
  oldMacAdopt,
  oldMacCiOnly,
  oldMacContainmentReadback,
  oldMacDownloadedState,
  oldMacLaunch,
  oldMacStopApps,
  oldShipItBaseline,
  paintedMacDesktop,
  prepareOldMacNative,
  restoreOldMacNetwork,
} from './mac-old-native.mts';
import { MacOldUi, macAbout, macDebugPort, macDebugTargets } from './mac-old-ui.mts';
import { transportHook } from './transport.mts';
import { macSerializedFunction } from './mac-serialization.mts';

import type { TransportState } from './transport.mts';
import { observeOldMac } from './mac-old-observer.mts';
import type { OtaState } from './mac-old-observer.mts';

const repository = '777genius/agent-teams-ai';
interface Pause {
  callFrames: { callFrameId: string }[];
}
const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      [
        'plan',
        'plan-sha256',
        'input-digest',
        'tooling-sha',
        'architecture',
        'scenario',
        'feed-mode',
        'inputs',
        'input-artifact-id',
        'input-artifact-sha256',
        'evidence',
      ].map((name) => [name, { type: 'string' as const }])
    ),
    'restore-network': { type: 'boolean' },
  },
  strict: true,
  allowPositionals: false,
});
function required(name: string) {
  const value: unknown = Reflect.get(values, name);
  requireThat(typeof value === 'string' && value.length > 0, `--${name} required`);
  return value;
}
oldMacCiOnly();
const output = path.resolve(required('evidence'));
const runner = await realpath(process.env.RUNNER_TEMP ?? '');
assert(output.startsWith(`${runner}/TEST-mac-old-evidence-`));
await mkdir(output, { recursive: true });
const commands = new MacCommands(output);
if (values['restore-network']) {
  await restoreOldMacNetwork(commands);
  await writeFile(path.join(output, 'emergency-cleanup.json'), `${canonical(commands.commands)}\n`);
  process.exit(0);
}
const scenario = required('scenario');
assert(scenario === 'older' || scenario === 'fresh');
const mode = required('feed-mode');
assert(mode === 'preview' || mode === 'staged');
const architecture = required('architecture');
assert(architecture === 'arm64' || architecture === 'x64');
assert.equal(process.arch, architecture);
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  scenario: scenario === 'older' ? 'mac-2.17.0-to-carried-2.17.1' : 'mac-fresh-2.17.1',
  architecture,
  feedMode: mode,
  expectedVersion: '2.17.1',
  passed: false,
  automaticSuccessorProved: false,
  diagnosticRelaunchOnly: false,
  finalPromotionFeed: false,
  planBindingVerified: false,
  minimumOsExecutionProved: false,
  scope:
    'Older native Squirrel OTA and fresh install only; the separate current no-update row remains independently gated',
  commands: commands.commands,
};
let main: Cdp | undefined;
let renderer: Cdp | undefined;
let controls: MacOldUi | undefined;
function view() {
  assert(controls);
  return controls;
}
let app: string | undefined;
let home: string | undefined;
let profile: Awaited<ReturnType<typeof freshMacHome>> | undefined;
let mirror: Awaited<ReturnType<typeof macReleaseMirror>> | undefined;
let native: Awaited<ReturnType<typeof prepareOldMacNative>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
let networkOwned = false;
let commonTag: string | undefined;
let commonVersion: string | undefined;
const children: ReturnType<typeof spawn>[] = [];
const streams: ReturnType<typeof createWriteStream>[] = [];
const streamErrors: string[] = [];

async function transport() {
  assert(main);
  const state = await main.evaluate<TransportState>('globalThis.__TEST_nativeUpdater');
  assert(!state.error, state.error);
  return state;
}
async function observation() {
  assert(main);
  const state = await main.evaluate<OtaState>('globalThis.__TEST_oldMac');
  assert(!state.providerError, state.providerError);
  assert(!state.events.some((event) => event.type === 'error'), canonical(state));
  assert(!state.native.some((event) => event.type === 'error'), canonical(state));
  return state;
}
async function config() {
  assert(home);
  return JSON.parse(
    await readFile(path.join(home, '.claude', 'agent-teams-config.json'), 'utf8')
  ) as { general: { theme: string } };
}
async function launch(label: string, version: string) {
  assert(app && home && profile && mirror);
  const mirrorRequestStart = mirror.requests.length;
  const executable = path.join(app, 'Contents', 'MacOS', 'Agent Teams AI');
  const resources = path.join(app, 'Contents', 'Resources');
  const mainPort = await macDebugPort();
  const rendererPort = await macDebugPort();
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    USER: profile.user,
    LOGNAME: profile.user,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'production',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
  };
  const index = await oldMacLaunch(commands);
  child = spawn(
    executable,
    [
      `--inspect-brk=127.0.0.1:${mainPort}`,
      `--remote-debugging-port=${rendererPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--lang=en-US',
    ],
    { cwd: path.dirname(path.dirname(app)), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  let launchError: Error | undefined;
  child.on('error', (error) => {
    launchError = error;
  });
  assert(child.pid);
  await oldMacLaunch(commands, index, child.pid);
  const log = createWriteStream(path.join(output, `${label}-desktop.log`));
  streams.push(log);
  log.on('error', (error) => streamErrors.push(String(error)));
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (bytes: Buffer) => log.write(bytes));
  const owner = await macLaunchOwner(commands, child, child.pid, executable);
  await oldMacLaunch(commands, index, child.pid, owner);
  const inspector = await waitFor(
    async () => {
      if (launchError) throw launchError;
      assert.equal(child?.exitCode, null);
      return (
        (await macDebugTargets(mainPort))?.find((target) => target.webSocketDebuggerUrl) ?? null
      );
    },
    'original signed Mac inspector',
    20_000
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
    'original CJS entry pause',
    15_000
  );
  const frame = paused.callFrames[0];
  assert(frame);
  assert.equal(
    await main.evaluate<string>('__filename', frame.callFrameId),
    path.join(resources, 'app.asar', 'dist-electron/main/index.cjs')
  );
  await main.evaluate(
    `(${macSerializedFunction(transportHook)})(require('electron'),()=>autoUpdater,${JSON.stringify(mirror.origin)},${JSON.stringify(mirror.paths)});(${macSerializedFunction(observeOldMac)})(require('electron'),()=>autoUpdater)`,
    frame.callFrameId
  );
  await main.send('Debugger.resume');
  const state = await waitFor(
    async () => {
      const value = await transport();
      return value.roots ? value : null;
    },
    'two original Electron sessions bound before startup',
    30_000
  );
  assert.deepEqual(state.bound, ['default', 'electron-updater']);
  assert.equal(state.updater?.class, 'MacUpdater');
  assert.equal(state.roots?.home, home);
  assert.equal(state.roots?.executable, executable);
  assert.equal(state.roots?.resources, resources);
  assert.equal(state.roots?.version, version);
  assert.equal(state.roots?.arch, architecture);
  assert.equal(state.roots?.packaged, true);
  assert(
    state.roots && profile.candidates.includes(state.roots.userData),
    'Only verified-empty physical Aqua default appdata is allowed'
  );
  assert.equal((await stat(state.roots.userData)).uid, process.getuid?.());
  const page = await waitFor(
    async () =>
      (await macDebugTargets(rendererPort))?.find(
        (target) => target.type === 'page' && target.url.startsWith('file:')
      ) ?? null,
    'native app renderer',
    30_000
  );
  renderer = await Cdp.connect(page.webSocketDebuggerUrl);
  controls = new MacOldUi(renderer, output);
  await renderer.send('Page.enable');
  await waitFor(
    () =>
      renderer!.evaluate<boolean | null>(
        '!document.getElementById("splash")&&document.readyState==="complete"?true:null'
      ),
    'painted app renderer',
    45_000
  );
  return {
    owner,
    roots: state.roots,
    environmentKeys: Object.keys(env),
    launchIndex: index,
    mirrorRequestStart,
  };
}
async function noUpdate(version: string, label: string, requestStart: number) {
  assert(commonTag && commonVersion);
  const startup = await waitFor(
    async () => {
      const state = await observation();
      assert(
        !state.events.some((event) => ['available', 'downloaded', 'progress'].includes(event.type))
      );
      return state.events.some(
        (event) => event.type === 'not-available' && event.version === version
      )
        ? state
        : null;
    },
    'genuine startup no-update',
    30_000
  );
  await view().settings();
  await view().click('^Advanced$');
  assert(renderer);
  assert(
    await renderer.evaluate<boolean>(
      `(() => {const block=${macAbout};return Boolean(block&&/Version\\s+2\\.17\\.1\\b/.test(block.textContent));})()`
    )
  );
  await view().click('^Check for Updates$', macAbout);
  const checked = await waitFor(
    async () => {
      const state = await observation();
      assert(
        !state.events.some((event) => ['available', 'downloaded', 'progress'].includes(event.type))
      );
      return state.events.filter((event) => event.type === 'not-available').length >
        startup.events.filter((event) => event.type === 'not-available').length && state.provider
        ? state
        : null;
    },
    'UI-triggered genuine no-update',
    30_000
  );
  assert.equal(checked.provider, 'GitHubProvider');
  assert.equal(checked.candidateVersion, '2.17.1');
  const body = await waitFor(
    () =>
      renderer!.evaluate<string | null>(
        `(() => {const block=${macAbout};return block&&[...block.querySelectorAll('button')].some(b=>b.textContent.trim()==='Up to date')?block.innerText:null;})()`
      ),
    'painted About Up to date'
  );
  const snapshot = await view().snapshot();
  assert(!snapshot.body.includes(commonVersion));
  assert(!snapshot.dialogs.some((dialog) => /download|restart|install update/i.test(dialog)));
  const observed = await transport();
  assert(mirror);
  const requests = mirror.requests.slice(requestStart);
  assert(
    !requests.some((request) => request.method === 'GET' && /\.(zip|dmg)$/.test(request.path))
  );
  for (const suffix of ['/releases.atom', '/releases/latest', `/${commonTag}/latest-mac.yml`])
    assert(
      requests.some(
        (request) =>
          request.method === 'GET' &&
          request.status === 200 &&
          request.session === 'electron-updater' &&
          request.path.endsWith(suffix)
      )
    );
  assert(
    !observed.requests.some(
      (request) => request.method === 'GET' && /\.(zip|dmg)(\?|$)/.test(request.url)
    )
  );
  await view().screenshot(label);
  return { startup, checked, body, ui: snapshot, transport: observed, requests };
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
  const plan = await loadPlan(required('plan'), required('plan-sha256'));
  assert.equal(digest(canonical(plan.input)), required('input-digest'));
  assert.equal(plan.input.toolingSha, toolingSha);
  assert.equal(plan.input.repository, repository);
  assert.equal(plan.input.mode, 'carry-mac');
  assert.equal(plan.input.macSource?.release.applicationSha, sourceSha);
  assert.equal(plan.input.macSource?.release.tag, 'v2.17.1');
  assert.equal(plan.input.target.tag, 'v2.17.3');
  commonTag = plan.input.target.tag;
  commonVersion = version(commonTag);
  evidence.previewCommonTag = commonTag;
  evidence.targetApplicationSha = plan.input.target.applicationSha;
  evidence.build = plan.input.build;
  assert(/^[a-f0-9]{40}$/.test(plan.input.target.applicationSha));
  const root = await mkdtemp(path.join(runner, 'TEST-mac-old-'));
  evidence.root = root;
  profile = await freshMacHome(commands);
  home = profile.home;
  evidence.isolation = profile;
  native = await prepareOldMacNative(commands);
  evidence.nativeReaders = native;
  await oldShipItBaseline(commands, native.job);
  const inputs = await readMacInputs(plan, required('inputs'), mode, architecture, evidence, {
    planSha256: required('plan-sha256'),
    inputDigest: required('input-digest'),
    toolingSha,
    artifactId: Number(required('input-artifact-id')),
    artifactSha256: required('input-artifact-sha256'),
  });
  const zip = inputs.files.get(inputs.names.zip);
  const dmg = inputs.files.get(inputs.names.dmg);
  assert(zip && dmg);
  const reference = path.join(root, 'TEST-reference');
  await mkdir(reference);
  await commands.checked('extract-unmodified-reference-zip', '/usr/bin/ditto', [
    '-x',
    '-k',
    zip.file,
    reference,
  ]);
  const targetApp = path.join(reference, 'Agent Teams AI.app');
  const referenceSignature = await macBundleSignature(
    commands,
    targetApp,
    architecture,
    '2.17.1',
    'reference'
  );
  evidence.referenceSignature = referenceSignature;
  const targetSources = await captureOldMacSources(commands, targetApp, 'reference');
  assert.equal(targetSources.packageVersion, '2.17.1');
  evidence.targetSources = targetSources;
  const installRoot = path.join(root, 'TEST-Applications');
  await mkdir(installRoot);
  app = path.join(installRoot, 'Agent Teams AI.app');
  const archive =
    scenario === 'older' ? await oldMacInstaller(root, architecture, evidence) : dmg.file;
  await macDmgInstall(commands, archive, app, path.join(root, 'TEST-mount'));
  const initialVersion = scenario === 'older' ? '2.17.0' : '2.17.1';
  evidence.signatureBefore = await macBundleSignature(
    commands,
    app,
    architecture,
    initialVersion,
    'before'
  );
  await commands.checked('existing-stapled-app-ticket', '/usr/bin/xcrun', [
    'stapler',
    'validate',
    '-v',
    app,
  ]);
  const assessed = await commands.checked('online-gatekeeper', '/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    '--ignore-cache',
    '--no-cache',
    app,
  ]);
  assert(assessed.stderr.includes('source=Notarized Developer ID'));
  const initialSources = await captureOldMacSources(commands, app, 'initial');
  assert.equal(initialSources.packageVersion, initialVersion);
  evidence.initialSources = initialSources;
  evidence.coldCache = await coldMacUpdaterCache(home, initialSources.updateConfig);
  if (scenario === 'fresh') sameProof(initialSources.asar, targetSources.asar);
  mirror = await macReleaseMirror(plan, inputs.source, inputs.files, inputs.feed);
  await oldShipItBaseline(commands, native.job);
  networkOwned = true;
  evidence.network = await containOldMacNetwork(commands, app, home, native);
  assert.equal(
    await (
      await fetch(
        `${mirror.origin}/github/${repository}/releases/download/${plan.input.target.tag}/latest-mac.yml`
      )
    ).text(),
    inputs.feed
  );
  const initial = await launch('initial', initialVersion);
  evidence.initialLaunch = initial;
  if (scenario === 'fresh') {
    evidence.noUpdate = await noUpdate('2.17.1', 'fresh-no-update', initial.mirrorRequestStart);
    evidence.nativeWindow = await waitFor(
      () => paintedMacDesktop(commands, native!.aqua, initial.owner, 'fresh-aqua', false),
      'fresh painted Aqua desktop',
      30_000
    );
  } else {
    const available = await waitFor(
      async () => {
        const state = await observation();
        return state.provider &&
          state.events.some((event) => event.type === 'available' && event.version === '2.17.1')
          ? state
          : null;
      },
      'original GitHubProvider returns carried 2.17.1',
      30_000
    );
    assert.equal(available.provider, 'GitHubProvider');
    evidence.available = available;
    if (await view().point('^Later$', 'document.querySelector("[role=dialog]")'))
      await view().click('^Later$', 'document.querySelector("[role=dialog]")');
    await waitFor(
      () => renderer!.evaluate<boolean | null>('document.querySelector("[role=dialog]")?null:true'),
      'available dialog dismissed'
    );
    await view().settings();
    await view().click('^Light$');
    await waitFor(async () => {
      try {
        return (await config()).general.theme === 'light' ? true : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }, 'real Settings Light preference persisted');
    evidence.preferenceBefore = await config();
    await view().click('^Advanced$');
    assert(renderer);
    assert(
      await renderer.evaluate<boolean>(
        `(() => {const block=${macAbout};return Boolean(block&&/Version\\s+2\\.17\\.0\\b/.test(block.textContent));})()`
      )
    );
    const checks = available.events.filter((event) => event.type === 'available').length;
    await view().click('^(?:Check for Updates|v?2\\.17\\.1 available)$', macAbout);
    await waitFor(
      async () =>
        (await observation()).events.filter((event) => event.type === 'available').length > checks
          ? true
          : null,
      'real app Check for Updates completes'
    );
    if (!(await view().point('^Download$', 'document.querySelector("[role=dialog]")')))
      await view().click('^(?:Update app|View details)$');
    await view().screenshot('available');
    evidence.downloadAction = await view().click(
      '^Download$',
      'document.querySelector("[role=dialog]")'
    );
    await waitFor(
      async () =>
        (await observation()).events.some(
          (event) =>
            event.type === 'progress' && (event.percent ?? 0) > 0 && (event.percent ?? 100) < 100
        )
          ? true
          : null,
      'real ZIP download progress',
      120_000
    );
    evidence.progressUi = await waitFor(
      () =>
        renderer!.evaluate<string | null>(
          `(() => {const b=[...document.querySelectorAll('button')].find(b=>/\\d+%/.test(b.textContent));if(!b)return null;const r=b.getBoundingClientRect();return r.width&&r.height?b.textContent.trim():null;})()`
        ),
      'painted download progress'
    );
    await view().screenshot('progress');
    const downloaded = await waitFor(
      async () => {
        const state = await observation();
        return state.events.some(
          (event) => event.type === 'downloaded' && event.version === '2.17.1'
        ) && state.native.some((event) => event.type === 'downloaded')
          ? state
          : null;
      },
      'real Squirrel downloaded and verified completion',
      180_000
    );
    const cached = downloaded.events.find((event) => event.type === 'downloaded')?.downloadedFile;
    assert(cached);
    const cachedPath = await realpath(cached);
    assert(cachedPath.startsWith(`${home}/Library/Caches/`));
    assert.equal((await stat(cachedPath)).uid, process.getuid?.());
    sameProof(
      { ...(await fileProof(cachedPath, path.basename(zip.file))), name: path.basename(zip.file) },
      sourceMacPin(plan, path.basename(zip.file))
    );
    const shipit = await oldMacDownloadedState(commands);
    assert('updateBundle' in shipit && typeof shipit.updateBundle === 'string');
    evidence.nativeDownloadedState = shipit;
    const squirrelSignature = await macBundleSignature(
      commands,
      shipit.updateBundle,
      architecture,
      '2.17.1',
      'squirrel'
    );
    assert.equal(squirrelSignature.codeDirectoryHash, referenceSignature.codeDirectoryHash);
    evidence.squirrelStagedSignature = squirrelSignature;
    sameProof(
      await fileProof(
        path.join(shipit.updateBundle, 'Contents', 'Resources', 'app.asar'),
        'app.asar'
      ),
      targetSources.asar
    );
    evidence.downloaded = downloaded;
    evidence.transportBeforeRestart = await transport();
    for (const suffix of [
      '/releases.atom',
      '/releases/latest',
      `/${commonTag}/latest-mac.yml`,
      `/${commonTag}/${path.basename(zip.file)}`,
    ])
      assert(
        mirror.requests.some(
          (request) =>
            request.method === 'GET' &&
            request.status === 200 &&
            request.session === 'electron-updater' &&
            request.path.endsWith(suffix)
        )
      );
    assert(
      mirror.requests.some(
        (request) =>
          request.path === `/api/repos/${repository}/releases/tags/v2.17.1` &&
          request.method === 'GET' &&
          request.session === 'default' &&
          request.status === 200
      )
    );
    assert(
      mirror.requests.some(
        (request) =>
          request.path.endsWith(`/v2.17.1/${path.basename(dmg.file)}`) &&
          request.method === 'HEAD' &&
          request.session === 'default' &&
          request.status === 200
      )
    );
    assert(
      mirror.requests.some(
        (request) =>
          request.path.endsWith('/v2.17.1/latest-mac.yml') &&
          request.method === 'GET' &&
          request.session === 'default' &&
          request.status === 200
      )
    );
    assert(
      mirror.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.path.endsWith('.zip') &&
          request.completed &&
          request.bytes === zip.size &&
          !request.range
      )
    );
    if (!(await view().point('^Restart now$', 'document.querySelector("[role=dialog]")')))
      await view().click('^(?:Restart to update|View details)$');
    await waitFor(
      () => view().point('^Restart now$', 'document.querySelector("[role=dialog]")'),
      'real Restart now button'
    );
    await view().screenshot('downloaded');
    const restartTime = Date.now();
    evidence.installAction = await view().click(
      '^Restart now$',
      'document.querySelector("[role=dialog]")'
    );
    main?.close();
    renderer?.close();
    main = undefined;
    renderer = undefined;
    controls = undefined;
    const successor = await waitFor(
      () => automaticMacApp(commands, native!.aqua, app!, initial.owner, restartTime, architecture),
      'Squirrel automatically launched native successor',
      120_000
    );
    await oldMacAdopt(commands, successor.owner.pid);
    evidence.containmentAfterAutomatic = await oldMacContainmentReadback(commands);
    evidence.automaticSuccessor = successor;
    const automaticSignature = await macBundleSignature(
      commands,
      app,
      architecture,
      '2.17.1',
      'automatic'
    );
    assert.equal(automaticSignature.codeDirectoryHash, referenceSignature.codeDirectoryHash);
    evidence.signatureAfterAutomatic = automaticSignature;
    sameProof(
      await fileProof(path.join(app, 'Contents', 'Resources', 'app.asar'), 'app.asar'),
      targetSources.asar
    );
    assert.equal((await config()).general.theme, 'light');
    evidence.automaticDesktop = await waitFor(
      () => paintedMacDesktop(commands, native!.aqua, successor.owner, 'automatic-aqua', true),
      'automatically restarted painted Aqua desktop with preserved Light theme',
      60_000
    );
    evidence.automaticSuccessorProved = true;
    evidence.preferenceAfterAutomatic = await config();
    evidence.automaticArguments = (
      await commands.checked('automatic-app-arguments', '/bin/ps', [
        '-p',
        String(successor.owner.pid),
        '-o',
        'command=',
      ])
    ).stdout;
    assert(
      !(evidence.automaticArguments as string).includes('--inspect'),
      'Automatic native proof must precede diagnostic launch'
    );
    await oldMacStopApps(commands);
    const diagnostic = await launch('post-update-diagnostic', '2.17.1');
    assert.equal(diagnostic.roots.userData, initial.roots.userData);
    evidence.diagnosticLaunch = diagnostic;
    evidence.postUpdate = await noUpdate(
      '2.17.1',
      'post-update-no-update',
      diagnostic.mirrorRequestStart
    );
    assert.equal((await config()).general.theme, 'light');
    evidence.preferenceAfterDiagnostic = await config();
    evidence.diagnosticRelaunchOnly = false;
  }
  const finalSignature = await macBundleSignature(commands, app, architecture, '2.17.1', 'final');
  assert.equal(finalSignature.codeDirectoryHash, referenceSignature.codeDirectoryHash);
  evidence.signatureFinal = finalSignature;
  sameProof(
    await fileProof(path.join(app, 'Contents', 'Resources', 'app.asar'), 'app.asar'),
    targetSources.asar
  );
  assert.equal(mirror.failures.length, 0);
  assert.equal(streamErrors.length, 0);
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  evidence.lastTransport = await transport().catch(() => undefined);
  evidence.lastObservation = await observation().catch(() => undefined);
  await controls?.screenshot('failure-renderer').catch(() => undefined);
} finally {
  main?.close();
  renderer?.close();
  if (networkOwned) {
    try {
      await access(path.join(output, 'pf-owned.json'));
      evidence.networkRestore = await restoreOldMacNetwork(commands);
    } catch (error) {
      evidence.cleanupError = String(error);
      evidence.passed = false;
      process.exitCode = 1;
    }
  }
  // Releasing handles never signals an unresolved PID. Unsafe ownership keeps PF enabled until VM teardown.
  for (const app of children) {
    app.stdout?.destroy();
    app.stderr?.destroy();
    app.unref();
  }
  const settled = await Promise.allSettled([
    mirror?.close(),
    ...streams.map(
      (stream) =>
        new Promise<void>((resolve) => (stream.destroyed ? resolve() : stream.end(resolve)))
    ),
  ]);
  if (settled.some((result) => result.status === 'rejected') || streamErrors.length) {
    evidence.passed = false;
    process.exitCode = 1;
  }
  evidence.requests = mirror?.requests ?? [];
  evidence.mirrorFailures = mirror?.failures ?? [];
  evidence.streamErrors = streamErrors;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(output, 'mac-native-result.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  );
}
