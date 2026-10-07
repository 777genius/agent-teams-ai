import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readAsar } from './archive.mts';
import { waitFor } from './cdp.mts';
import { freshInstaller, freshSource, retrieveFreshProducer } from './windows-fresh-producer.mts';
import { hashFile } from './inputs.mts';
import { readPeArchitecture, windowsNative } from './windows-native.mts';
import { windowsOtaObserver } from './windows-ota-observer.mts';
import {
  absent,
  appEnvironment,
  ownPhysicalProfile,
  releasePhysicalProfile,
} from './windows-ota-profile.mts';
import { inheritedWindowsEnvironment } from './windows-powershell.mts';

import type { WindowsProcess } from './windows-native.mts';
import type { ProfileOwnership } from './windows-ota-profile.mts';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'arm64');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Only fresh disposable Windows ARM GHA VMs');
const diagnosticHead = process.env.DIAGNOSTIC_SHA;
assert(diagnosticHead && /^[a-f0-9]{40}$/u.test(diagnosticHead));
assert.equal(process.env.GITHUB_SHA, diagnosticHead, 'Actual reviewed diagnostic head required');
assert.notEqual(
  diagnosticHead,
  freshSource,
  'Diagnostic and tested application source are distinct'
);
function required(name: string) {
  const value = process.env[name];
  assert(value, `Required ${name}`);
  return value;
}
function id(name: string) {
  const value = required(name);
  assert(/^[1-9]\d*$/u.test(value));
  return Number(value);
}
const output = path.resolve(required('TEST_FRESH_EVIDENCE'));
assert(path.basename(output).startsWith('TEST-windows-'));
await mkdir(output, { recursive: true });
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-')));
const install = path.join(root, 'install'),
  executable = path.join(install, 'AgentTeamsAI.exe');
const installer = path.join(root, freshInstaller),
  group = `TEST-updater-windows-${randomUUID()}`;
const firewallNames: string[] = [];
const owners: WindowsProcess[] = [];
let native: Awaited<ReturnType<typeof windowsNative>> | undefined;
let observer: Awaited<ReturnType<typeof windowsOtaObserver>> | undefined;
let session: Awaited<ReturnType<NonNullable<typeof native>['session']>> | undefined;
let app: ReturnType<typeof spawn> | undefined;
let setup: ReturnType<typeof spawn> | undefined;
let nsisCompletedSuccessfully = false;
const log = createWriteStream(path.join(output, 'desktop.log'), { flags: 'wx' });
let logError: Error | undefined;
log.on('error', (error) => {
  logError = error;
});
const evidence: Record<string, unknown> = {
  scope: 'Fresh immutable 2.17.6 ARM NSIS installation and native main UI only',
  qualifying: false,
  fullOtaProved: false,
  passed: false,
  freshInstallProved: false,
  diagnosticHead,
  testedApplicationSha: freshSource,
  root,
  install,
  executable,
  installer,
  startedAt: new Date().toISOString(),
};
async function ownership() {
  await writeFile(
    path.join(output, 'ownership.json'),
    JSON.stringify(
      {
        root,
        executable,
        installer,
        group,
        firewallNames,
        owners,
        profileFile: path.join(output, 'profile-ownership.json'),
      },
      null,
      2
    )
  );
}
async function remember(file: string) {
  assert(native && session);
  const found = await native.processes(file);
  for (const owner of found) {
    assert.equal(owner.executable.toLowerCase(), file.toLowerCase());
    assert.equal(owner.sid, session.sid);
    assert.equal(owner.session, session.session);
    if (!owners.some((prior) => prior.pid === owner.pid && prior.start === owner.start))
      owners.push(owner);
  }
  await ownership();
  return found;
}
try {
  await ownership();
  const producer = await retrieveFreshProducer(
    {
      runId: id('PRODUCER_RUN_ID'),
      attempt: id('PRODUCER_ATTEMPT'),
      jobId: id('PRODUCER_JOB_ID'),
      artifactId: id('PRODUCER_ARTIFACT_ID'),
      artifactSha256: required('PRODUCER_ARTIFACT_SHA256'),
      testedApplicationSha: required('TESTED_APPLICATION_SHA'),
    },
    root
  );
  evidence.producer = producer;
  await copyFile(path.join(root, 'producer-proof.json'), path.join(output, 'producer-proof.json'));
  native = await windowsNative(root, output);
  observer = await windowsOtaObserver(root, output);
  session = await native.session();
  evidence.session = session;
  assert.equal(session.station.toLowerCase(), 'winsta0');
  assert.equal(session.desktop.toLowerCase(), 'default');
  assert.equal(session.administrator, true, 'Existing firewall containment requires administrator');
  const physical = await native.physicalProfile();
  evidence.profile = await ownPhysicalProfile(root, physical, output);
  await writeFile(
    path.join(root, 'user-data', 'TEST-fresh-diagnostic.json'),
    JSON.stringify({ source: freshSource, diagnosticHead, projects: [] }),
    { flag: 'wx' }
  );
  await mkdir(install);
  for (const [index, file] of [installer, executable].entries()) {
    const name = `${group}-${index}`;
    firewallNames.push(name);
    await ownership();
    await native.addFirewall(group, name, file);
  }
  const rules = await native.firewall(group);
  assert.equal(rules.length, 2);
  for (const rule of rules) {
    assert(firewallNames.includes(rule.name));
    assert.equal(rule.enabled, 'True');
    assert.equal(rule.action, 'Block');
    assert.equal(rule.direction, 'Outbound');
    assert(
      [installer, executable].some((file) => file.toLowerCase() === rule.program.toLowerCase())
    );
    assert.equal(rule.remote.length, 3, 'IPv4/IPv6 non-loopback containment required');
  }
  evidence.firewall = rules;
  const systemRoot = inheritedWindowsEnvironment('SystemRoot');
  assert(systemRoot);
  const env = appEnvironment(physical, root, systemRoot);
  evidence.childEnvironmentKeys = Object.keys(env);
  evidence.installerHash = await hashFile(installer);
  evidence.installerSignature = await native.signature(installer);
  const arguments_ = ['/S', `/D=${install}`];
  const started = Date.now();
  setup = spawn(installer, arguments_, {
    cwd: root,
    env,
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let setupError: Error | undefined;
  setup.on('error', (error) => {
    setupError = error;
  });
  for (const stream of [setup.stdout, setup.stderr])
    stream?.on('data', (chunk: Buffer) => log.write(chunk));
  const completion = new Promise<number | null>((resolve, reject) => {
    setup!.once('error', reject);
    setup!.once('exit', resolve);
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    completion,
    new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () =>
          reject(new Error('Fresh original NSIS exceeded 480000ms; strict owned cleanup required')),
        480_000
      );
    }),
  ]).finally(() => {
    clearTimeout(deadline);
  });
  evidence.install = {
    code,
    arguments: arguments_,
    elapsedMs: Date.now() - started,
    timeoutMs: 480_000,
    error: setupError?.message,
  };
  nsisCompletedSuccessfully = code === 0;
  assert.equal(code, 0, 'Original producer NSIS must install successfully');
  assert.equal((await remember(installer)).length, 0, 'Installer still running after exit');
  assert.equal((await remember(executable)).length, 0, 'Unexpected NSIS app auto-launch');
  const asar = path.join(install, 'resources', 'app.asar');
  assert((await stat(executable)).isFile() && (await stat(asar)).isFile());
  const signature = await native.signature(executable);
  const pe = await readPeArchitecture(executable);
  const packageBytes = (await readAsar(asar, ['package.json'])).get('package.json');
  assert(packageBytes);
  const metadata = JSON.parse(packageBytes.toString()) as { version: string };
  assert.equal(metadata.version, '2.17.6');
  assert.equal(pe.architecture, 'arm64');
  assert(
    /^2\.17\.6(?:\.0)?$/u.test(signature.fileVersion) &&
      /^2\.17\.6(?:\.0)?$/u.test(signature.productVersion)
  );
  evidence.installed = {
    exe: await hashFile(executable),
    asar: await hashFile(asar),
    pe,
    signature,
    packageVersion: metadata.version,
  };
  const appArguments = [
    '--force-renderer-accessibility',
    '--lang=en-US',
    `--user-data-dir=${path.join(root, 'user-data')}`,
  ];
  const launchAt = Date.now();
  app = spawn(executable, appArguments, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.on('error', (error) => {
    evidence.launchError = error.message;
  });
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => log.write(chunk));
  const owner = await waitFor(
    async () => (await remember(executable)).find((value) => value.pid === app!.pid) ?? null,
    'exact installer-created app owner',
    10_000
  );
  evidence.launch = { arguments: appArguments, owner };
  await mkdir(path.join(root, 'capture'));
  const attempts: unknown[] = [];
  evidence.uiAttempts = attempts;
  const window = await waitFor(
    async () => {
      assert(
        Date.now() - launchAt < 45_000,
        'Actual main UI must paint within 45 seconds from launch'
      );
      const captured = await native!.capture(owner, path.join(root, 'capture', 'fresh-native.png'));
      if (!captured) return null;
      const names = await observer!.names(owner, captured.hwnd);
      const text = names.join('\n');
      const ready =
        /Providers\s*&\s*plans/iu.test(text) &&
        /^Tasks$/imu.test(text) &&
        !/Preparing workspace/iu.test(text);
      attempts.push({ captured, names, ready, elapsedMs: Date.now() - launchAt });
      if (!ready) return null;
      assert(Date.now() - launchAt <= 45_000);
      assert.equal(captured.pid, owner.pid);
      assert.equal(captured.foreground, true);
      assert(captured.width >= 300 && captured.height >= 200);
      assert.equal(
        (await remember(executable)).find((value) => value.pid === owner.pid)?.start,
        owner.start
      );
      return { ...captured, names, elapsedMs: Date.now() - launchAt };
    },
    'actual owned foreground HWND and main UI accessibility',
    Math.max(1, 45_000 - (Date.now() - launchAt))
  );
  await copyFile(window.screenshot, path.join(output, 'fresh-native.png'));
  assert((await stat(path.join(output, 'fresh-native.png'))).size > 1000);
  evidence.nativeWindow = {
    ...window,
    screenshot: 'fresh-native.png',
    image: await hashFile(path.join(output, 'fresh-native.png')),
  };
  evidence.freshInstallProved = true;
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try {
    if (native && session) {
      for (const file of [installer, executable]) await remember(file);
      await native.stop(owners);
      for (let check = 0; check < 2; check++) {
        for (const file of [installer, executable])
          assert.equal(
            (await native.processes(file)).length,
            0,
            'Owned process remains or respawned'
          );
        if (check === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      evidence.processCleanup = 'Exact PID/start/SID owners stopped; no respawn observed';
      // Image-scoped ownership does not prove that NSIS-created system processes
      // exited after a timeout/error. Keep their profile and containment until VM teardown.
      assert(
        !setup || nsisCompletedSuccessfully,
        'NSIS exit 0 unproved; retain Firewall/profile for provider VM teardown'
      );
      assert.deepEqual(await native.removeFirewall(group, firewallNames), []);
      evidence.firewallRemoved = true;
      const profileFile = path.join(output, 'profile-ownership.json');
      if (!(await absent(profileFile))) {
        const profile = JSON.parse(await readFile(profileFile, 'utf8')) as ProfileOwnership;
        assert.equal(profile.root, root);
        await releasePhysicalProfile(profile);
        evidence.profileReleased = true;
      }
    } else assert(!setup && !app, 'No native ownership helper; retain VM until teardown');
  } catch (error) {
    evidence.cleanupError = String(error);
    evidence.cleanupIncomplete = true;
    evidence.providerVmTeardownRequired = true;
    evidence.containmentRetainedUntilVmTeardown = true;
    evidence.passed = false;
    evidence.freshInstallProved = false;
    process.exitCode = 1;
    for (const child of [setup, app]) {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
    }
  }
  if (logError) {
    evidence.logError = String(logError);
    evidence.passed = false;
    process.exitCode = 1;
  }
  await new Promise<void>((resolve) => {
    if (log.destroyed) resolve();
    else log.end(resolve);
  });
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(evidence, null, 2));
}
console.log(
  JSON.stringify({
    passed: evidence.passed,
    qualifying: false,
    fullOtaProved: false,
    evidence: output,
  })
);
