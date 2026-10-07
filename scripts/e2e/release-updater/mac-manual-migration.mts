import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { canonical, fileProof } from '../../ci/release/contract.ts';
import { readAsar } from './archive.mts';
import { Cdp, waitFor } from './cdp.mts';
import { macInputCommand } from './mac-input-artifact.mts';
import {
  MacCommands,
  captureMacWindow,
  macLaunchOwner,
  macOwner,
  macProcesses,
  prepareMacWindow,
  stopMacOwned,
} from './mac-loopback.mts';
import { checkManualContext, manualNames, readManualInputs } from './mac-manual-inputs.mts';
import { macDebugPort, macDebugTargets } from './mac-old-ui.mts';
import { macBundleSignature, macDmgInstall } from './mac-old-native.mts';
import { macCallFunction } from './mac-serialization.mts';

import type { MacIdentity } from './mac-old-native.mts';

const { values } = parseArgs({
  options: { inputs: { type: 'string' }, evidence: { type: 'string' } },
  strict: true,
});
const toolingSha = process.env.TOOLING_SHA ?? '';
checkManualContext(process.env, toolingSha);
assert.equal(process.env.GITHUB_JOB, 'mac-manual');
assert.equal(process.platform, 'darwin');
assert(process.arch === 'arm64' || process.arch === 'x64');
assert.equal(process.arch, process.env.ARCHITECTURE);
assert.equal((await macInputCommand(['rev-parse', 'HEAD'], 'git')).trim(), toolingSha);
const runner = await realpath(process.env.RUNNER_TEMP ?? '');
const output = path.resolve(values.evidence ?? '');
assert.equal(path.dirname(output), runner);
assert.equal(path.basename(output), 'TEST-mac-manual-evidence');
const inputs = path.resolve(values.inputs ?? '');
assert.equal(inputs, path.join(runner, 'TEST-mac-manual-inputs'));
await mkdir(output);
const commands = new MacCommands(output);
const uid = process.getuid?.();
assert(uid !== undefined && uid > 0);
assert.equal((await stat('/dev/console')).uid, uid, 'Native active Aqua account required');
await commands.checked('active-aqua-session', '/bin/launchctl', ['print', `gui/${uid}`]);
const os = (
  await commands.checked('actual-macos-version', '/usr/bin/sw_vers', ['-productVersion'])
).stdout.trim();
assert(Number(os.split('.')[0]) >= 13);
const expected = {
  toolingSha,
  runId: Number(process.env.GITHUB_RUN_ID),
  attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  artifactId: Number(process.env.INPUT_ARTIFACT_ID),
  artifactSha256: process.env.INPUT_ARTIFACT_SHA256 ?? '',
  planDigest: process.env.PLAN_SHA256 ?? '',
  inputDigest: process.env.INPUT_DIGEST ?? '',
};
const { plan, bundle, authority } = await readManualInputs(inputs, expected);
const root = await mkdtemp(path.join(runner, 'TEST-mac-manual-owned-'));
const app = path.join(root, 'Agent Teams AI.app');
const executable = path.join(app, 'Contents', 'MacOS', 'Agent Teams AI');
const architecture = process.arch;
const names = manualNames(architecture);
const archiveRoot = path.join(root, 'transported');
await mkdir(archiveRoot);
// Existing archive verifier expects only new-Team ZIP/DMG files in its directory.
for (const name of [names.dmg, names.zip])
  await commands.checked('copy-authenticated-archive', '/usr/bin/ditto', [
    path.join(inputs, architecture, name),
    path.join(archiveRoot, name),
  ]);
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  repository: plan.input.repository,
  toolingSha,
  sourceSha: plan.input.target.applicationSha,
  version: '2.17.7',
  architecture,
  actualMacOs: os,
  minimumOs13ExecutionProven: Number(os.split('.')[0]) === 13,
  producer: authority,
  inputs: bundle,
  ownedRoot: root,
  phases: [],
};
const phases = evidence.phases as unknown[];
let owner: MacIdentity | undefined;
let child: ReturnType<typeof spawn> | undefined;
let main: Cdp | undefined;
let renderer: Cdp | undefined;
let log: ReturnType<typeof createWriteStream> | undefined;
let logError: Error | undefined;
let launchRegistered = false;
let failure: Error | undefined;
let cleanupPassed = false;
const windowReader = await prepareMacWindow(commands);
const foregroundSource = path.join(output, 'TEST-frontmost.swift');
const foregroundBinary = path.join(output, 'TEST-frontmost');
await writeFile(
  foregroundSource,
  `import AppKit
import Foundation
guard let app = NSWorkspace.shared.frontmostApplication, let executable = app.executableURL?.path else { exit(2) }
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["pid": Int(app.processIdentifier), "executable": executable], options: [.sortedKeys]))
`,
  { flag: 'wx' }
);
await commands.checked('compile-frontmost-reader', '/usr/bin/xcrun', [
  'swiftc',
  foregroundSource,
  '-o',
  foregroundBinary,
]);
async function foreground() {
  assert(owner);
  const observed = JSON.parse(
    (await commands.checked('actual-frontmost-application', foregroundBinary, [])).stdout
  ) as { pid: number; executable: string };
  assert.equal(observed.pid, owner.pid);
  assert.equal(observed.executable, owner.command);
  assert.deepEqual(await macOwner(commands, owner.pid, executable), owner);
  return observed;
}
async function persist() {
  await writeFile(path.join(output, 'native-manual-receipt.json'), `${canonical(evidence)}\n`);
}
async function noAppProcesses() {
  assert.equal(
    (await macProcesses(commands)).filter((item) => item.command.startsWith(`${app}/Contents/`))
      .length,
    0,
    'Owned bundle processes remain'
  );
}
async function assertUnmounted() {
  const device = (await stat(root)).dev;
  for (const mount of ['fresh-mount', 'old-mount', 'replacement-mount']) {
    try {
      assert.equal(
        (await stat(path.join(root, mount))).dev,
        device,
        'Owned DMG remains mounted; retain fixture'
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
async function stop() {
  renderer?.close();
  main?.close();
  renderer = undefined;
  main = undefined;
  if (owner) {
    phases.push({ cleanup: await stopMacOwned(commands, owner, app) });
    owner = undefined;
  } else
    assert(
      !launchRegistered || child?.exitCode !== null || child?.signalCode !== null,
      'Spawn identity unresolved; no destructive cleanup allowed'
    );
  await noAppProcesses();
  if (log)
    await new Promise<void>((resolve, reject) => {
      log!.end(() => (logError ? reject(logError) : resolve()));
    });
  log = undefined;
  child = undefined;
  launchRegistered = false;
}
async function installed(label: string, version: '2.17.1' | '2.17.7') {
  const resources = path.join(app, 'Contents', 'Resources');
  const packageBytes = (await readAsar(path.join(resources, 'app.asar'), ['package.json'])).get(
    'package.json'
  );
  assert(packageBytes);
  assert.equal((JSON.parse(packageBytes.toString()) as { version: string }).version, version);
  if (version === '2.17.1') return macBundleSignature(commands, app, architecture, version, label);
  await commands.checked('new-team-signing-notary-gatekeeper', '/bin/bash', [
    path.resolve('scripts/ci/verify-macos-signing.sh'),
    app,
    '--notarized',
  ]);
  for (const [key, value] of [
    ['CFBundleShortVersionString', version],
    ['CFBundleIdentifier', 'com.agent-teams.app'],
    ['LSMinimumSystemVersion', '13.0'],
  ])
    assert.equal(
      (
        await commands.checked('installed-plist', '/usr/libexec/PlistBuddy', [
          '-c',
          `Print :${key}`,
          path.join(app, 'Contents', 'Info.plist'),
        ])
      ).stdout.trim(),
      value
    );
  await commands.checked('installed-architecture', process.execPath, [
    path.resolve('scripts/electron-builder/verifyBundle.cjs'),
    app,
    'darwin',
    architecture,
  ]);
  const locks = [];
  for (const [name, directory, version, binary] of [
    ['runtime', 'runtime', '0.0.105', 'claude-multimodel'],
    ['terminal-platform', 'terminal-platform', '0.3.3', 'terminal-daemon'],
  ]) {
    assert(name && directory && version && binary);
    const lockFile = path.resolve(`${name}.lock.json`);
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as {
      version: string;
      assets: Record<string, { sha256: string }>;
    };
    assert.equal(lock.version, version);
    const pin = lock.assets[`darwin-${architecture}`];
    assert(pin && /^[a-f0-9]{64}$/.test(pin.sha256));
    const installedBinary = path.join(resources, directory, binary);
    assert.equal(
      (await readFile(path.join(resources, directory, 'VERSION'), 'utf8')).trim(),
      version
    );
    assert.equal(
      (
        await commands.checked('locked-binary-architecture', '/usr/bin/lipo', [
          '-archs',
          installedBinary,
        ])
      ).stdout.trim(),
      architecture === 'arm64' ? 'arm64' : 'x86_64'
    );
    locks.push({
      lock: await fileProof(lockFile, `${name}.lock.json`),
      archiveSha256: pin.sha256,
      signedInstalledBinary: await fileProof(installedBinary, `${directory}/${binary}`),
      version,
    });
  }
  return {
    version,
    architecture,
    teamIdentifier: '86399583GS',
    productMinimum: '13.0',
    locks,
    asar: await fileProof(path.join(resources, 'app.asar'), 'app.asar'),
  };
}
async function launch(
  label: string,
  profile: string,
  version: string,
  seed?: true,
  expectedTheme?: string
) {
  const home = path.join(profile, 'home');
  const userData = path.join(profile, 'user-data');
  const claude = path.join(home, '.claude');
  const tmp = path.join(profile, 'tmp');
  for (const directory of [
    home,
    userData,
    claude,
    tmp,
    path.join(home, 'Library', 'Application Support'),
  ])
    await mkdir(directory, { recursive: true });
  const mainPort = await macDebugPort();
  const rendererPort = await macDebugPort();
  const launchOutput = path.join(output, label);
  await mkdir(launchOutput);
  const captureCommands = new MacCommands(launchOutput);
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_CONFIG_DIR: claude,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: userData,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claude,
    NODE_ENV: 'production',
    LANG: 'en_US.UTF-8',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
  };
  log = createWriteStream(path.join(launchOutput, 'desktop.log'), {
    flags: 'wx',
  });
  logError = undefined;
  log.on('error', (error) => {
    logError = error;
  });
  launchRegistered = true;
  await writeFile(
    path.join(launchOutput, 'launch.json'),
    canonical({
      executable,
      profile,
      version,
      startedAt: new Date().toISOString(),
    }),
    { flag: 'wx' }
  );
  child = spawn(
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
  let launchError: Error | undefined;
  child.on('error', (error) => {
    launchError = error;
  });
  assert(child.pid);
  await writeFile(
    path.join(launchOutput, 'spawn.json'),
    canonical({ pid: child.pid, executable, profile }),
    { flag: 'wx' }
  );
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (bytes: Buffer) => log?.write(bytes));
  owner = await macLaunchOwner(commands, child, child.pid, executable);
  await writeFile(path.join(launchOutput, 'owner.json'), canonical(owner), {
    flag: 'wx',
  });
  const inspector = await waitFor(
    async () => {
      if (launchError) throw launchError;
      assert.equal(child?.exitCode, null);
      return (
        (await macDebugTargets(mainPort))?.find((target) => target.webSocketDebuggerUrl) ?? null
      );
    },
    'owned signed main inspector',
    20_000
  );
  main = await Cdp.connect(inspector.webSocketDebuggerUrl);
  await main.send('Debugger.enable');
  await main.send('Runtime.runIfWaitingForDebugger');
  const paused = await waitFor(
    () =>
      Promise.resolve(
        (main!.events.find((event) => event.method === 'Debugger.paused')?.params as
          | { callFrames: { callFrameId: string }[] }
          | undefined) ?? null
      ),
    'signed CJS entry pause',
    15_000
  );
  const frame = paused.callFrames[0];
  assert(frame);
  assert.equal(
    await main.evaluate<string>('__filename', frame.callFrameId),
    path.join(app, 'Contents', 'Resources', 'app.asar', 'dist-electron/main/index.cjs')
  );
  // Test fixture paths are bound before the original signed application executes.
  const roots = await macCallFunction<{
    home: string;
    userData: string;
    nodeHome: string;
    executable: string;
    arch: string;
  }>(
    main,
    '(()=>{const app=require("electron").app;const os=require("node:os");return (home,userData,tmp)=>{app.setPath("home",home);app.setPath("appData",home+"/Library/Application Support");app.setPath("userData",userData);app.setPath("sessionData",userData);app.setPath("temp",tmp);globalThis.__TEST_manualRoots=()=>({home:app.getPath("home"),userData:app.getPath("userData"),nodeHome:os.homedir(),executable:process.execPath,arch:process.arch,version:app.getVersion(),packaged:app.isPackaged});return globalThis.__TEST_manualRoots();};})()',
    [home, userData, tmp],
    frame.callFrameId
  );
  assert(roots);
  assert.deepEqual(
    {
      home: roots.home,
      userData: roots.userData,
      nodeHome: roots.nodeHome,
      executable: roots.executable,
      arch: roots.arch,
    },
    { home, userData, nodeHome: home, executable, arch: architecture }
  );
  await main.send('Debugger.resume');
  const page = await waitFor(
    async () =>
      (await macDebugTargets(rendererPort))?.find(
        (target) =>
          target.type === 'page' &&
          target.url.startsWith('file:') &&
          decodeURIComponent(new URL(target.url).pathname).startsWith(
            `${app}/Contents/Resources/app.asar/`
          )
      ) ?? null,
    'owned packaged renderer',
    30_000
  );
  renderer = await Cdp.connect(page.webSocketDebuggerUrl);
  await waitFor(
    () =>
      renderer!.evaluate<boolean>(
        'document.readyState === "complete" && typeof window.electronAPI?.config?.get === "function" && typeof window.electronAPI?.config?.update === "function"'
      ),
    'public config IPC',
    30_000
  );
  const bound = await main.evaluate<{
    home: string;
    userData: string;
    nodeHome: string;
    executable: string;
    arch: string;
    version: string;
    packaged: boolean;
  }>('globalThis.__TEST_manualRoots()');
  assert.deepEqual(bound, {
    home,
    userData,
    nodeHome: home,
    executable,
    arch: architecture,
    version,
    packaged: true,
  });
  async function preference(expression: string) {
    const result = await renderer!.send<{
      result: { value: string };
      exceptionDetails?: unknown;
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    assert(['dark', 'light', 'system'].includes(result.result.value));
    return result.result.value;
  }
  const before = await preference(
    '(async()=> (await window.electronAPI.config.get()).general.theme)()'
  );
  const seededTheme = before === 'light' ? 'dark' : 'light';
  const theme = seed ? seededTheme : (expectedTheme ?? before);
  if (seed) {
    await preference(
      `(async()=>{await window.electronAPI.config.update("general",{theme:${JSON.stringify(theme)}});return (await window.electronAPI.config.get()).general.theme;})()`
    );
    await waitFor(
      async () => {
        try {
          const persisted = JSON.parse(
            await readFile(path.join(claude, 'agent-teams-config.json'), 'utf8')
          ) as { general: { theme: string } };
          return persisted.general.theme === theme;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      },
      'owned seeded preference persisted before byte proof',
      10_000
    );
  }
  const after = await preference(
    '(async()=> (await window.electronAPI.config.get()).general.theme)()'
  );
  assert.equal(after, theme);
  if (theme !== 'system')
    await waitFor(
      () =>
        renderer!.evaluate<boolean>(
          `document.documentElement.classList.contains("dark") === ${theme === 'dark'}`
        ),
      'painted preserved theme',
      10_000
    );
  assert.deepEqual(await macOwner(commands, owner.pid, executable), owner);
  const foregroundBefore = await foreground();
  const painted = await captureMacWindow(captureCommands, windowReader, owner, app);
  const foregroundAfter = await foreground();
  const result = {
    label,
    foregroundBefore,
    foregroundAfter,
    roots: bound,
    profile,
    before,
    theme: after,
    preferenceAuthority: 'public config IPC and painted renderer theme',
    painted,
    ...(seed || expectedTheme !== undefined
      ? {
          configProof: await fileProof(
            path.join(claude, 'agent-teams-config.json'),
            'seeded-config.json'
          ),
        }
      : {}),
  };
  phases.push(result);
  await persist();
  await stop();
  return theme;
}
try {
  await persist();
  await commands.checked(
    'transported-zip-dmg-signing',
    '/bin/bash',
    [path.resolve('scripts/ci/verify-macos-archives.sh'), archiveRoot],
    600_000
  );
  await macDmgInstall(
    commands,
    path.join(inputs, architecture, names.dmg),
    app,
    path.join(root, 'fresh-mount')
  );
  phases.push({ freshSignature: await installed('fresh', '2.17.7') });
  for (const script of ['smokePackagedApp.cjs', 'smokePackagedNative.cjs', 'smokePackagedMcp.cjs'])
    await commands.checked(
      'installed-packaged-smoke',
      process.execPath,
      [path.resolve('scripts/electron-builder', script), app, 'darwin'],
      180_000
    );
  await launch('fresh217', path.join(root, 'fresh-profile'), '2.17.7');
  await noAppProcesses();
  await rm(app, { recursive: true });
  await macDmgInstall(
    commands,
    path.join(inputs, architecture, names.old),
    app,
    path.join(root, 'old-mount')
  );
  phases.push({ oldSignature: await installed('old211', '2.17.1') });
  const profile = path.join(root, 'migration-profile');
  const theme = await launch('original211', profile, '2.17.1', true);
  const profileBefore = await fileProof(
    path.join(profile, 'home', '.claude', 'agent-teams-config.json'),
    'seeded-config.json'
  );
  await noAppProcesses();
  await rm(app, { recursive: true });
  await macDmgInstall(
    commands,
    path.join(inputs, architecture, names.dmg),
    app,
    path.join(root, 'replacement-mount')
  );
  assert.deepEqual(
    await fileProof(
      path.join(profile, 'home', '.claude', 'agent-teams-config.json'),
      'seeded-config.json'
    ),
    profileBefore
  );
  phases.push({
    replacementSignature: await installed('replacement217', '2.17.7'),
    profileBefore,
    preservedBeforeLaunch: await fileProof(
      path.join(profile, 'home', '.claude', 'agent-teams-config.json'),
      'seeded-config.json'
    ),
  });
  assert.equal(await launch('manual217', profile, '2.17.7', undefined, theme), theme);
  evidence.passed = true;
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  evidence.passed = false;
  evidence.error = String(error);
} finally {
  try {
    await stop();
    await noAppProcesses();
    await assertUnmounted();
    cleanupPassed = true;
  } catch (error) {
    evidence.cleanupError = String(error);
  }
  evidence.cleanupPassed = cleanupPassed;
  evidence.commands = commands.commands;
  if (cleanupPassed) {
    await rm(app, { recursive: true, force: true });
    if (!failure) await rm(root, { recursive: true });
  }
  evidence.finishedAt = new Date().toISOString();
  await persist();
}
assert(cleanupPassed, 'Owned Mac native cleanup not proven; retained fixture');
if (failure) throw failure;
assert.equal(evidence.passed, true);
