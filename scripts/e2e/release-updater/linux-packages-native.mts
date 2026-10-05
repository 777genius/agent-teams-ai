import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { parse } from 'yaml';

import { captureSources, readAsar, readInspectorFuse } from './archive.mts';
import { Cdp, waitFor } from './cdp.mts';
import { digest } from '../../ci/release/contract.ts';
import { hashFile, repository } from './inputs.mts';
import { captureNativeWindow, processIdentity } from './native-window.mts';

import type { PackageKind } from './linux-packages-inputs.mts';

const execute = promisify(execFile);
export type Identity = NonNullable<Awaited<ReturnType<typeof processIdentity>>>;
export interface OwnedPackageApp extends Identity {
  executable: string;
  command: string[];
}
export interface WindowProcess {
  windowId: number;
  contentsId: number;
  pid: number;
  sandbox?: boolean;
}
export interface PackageUpdateEvent {
  type: string;
  version?: string;
  percent?: number;
  transferred?: number;
}
export function observePackage(
  electron: Pick<typeof import('electron'), 'app' | 'BrowserWindow'>,
  updater: () => {
    on(event: string, listener: (info: Omit<PackageUpdateEvent, 'type'>) => void): unknown;
  }
) {
  const events: PackageUpdateEvent[] = [];
  const observation = globalThis as typeof globalThis & {
    __TEST_packageEvents: PackageUpdateEvent[];
    __TEST_packagePreferences: () => WindowProcess[];
  };
  observation.__TEST_packageEvents = events;
  // Retain original CJS-owned Electron module for read-only window observation.
  observation.__TEST_packagePreferences = () =>
    electron.BrowserWindow.getAllWindows().map((window) => {
      const contents = window.webContents as typeof window.webContents & {
        getLastWebPreferences?: () => { sandbox?: boolean };
      };
      if (typeof contents.getLastWebPreferences !== 'function')
        throw new Error('Original Electron cannot expose effective renderer preferences');
      return {
        windowId: window.id,
        contentsId: contents.id,
        pid: contents.getOSProcessId(),
        sandbox: contents.getLastWebPreferences().sandbox,
      };
    });
  electron.app.once('ready', () => {
    for (const type of ['download-progress', 'update-downloaded', 'update-not-available'])
      updater().on(type, (info) =>
        events.push({
          type,
          version: info.version,
          percent: info.percent,
          transferred: info.transferred,
        })
      );
  });
}
const tools = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
export async function packageDatabase(kind: PackageKind) {
  const query = {
    deb: ['dpkg-query', ['-W', '-f=${Version}\n', 'agent-teams-ai']],
    rpm: ['rpm', ['-q', '--qf', '%{VERSION}\n', 'agent-teams-ai']],
    pacman: ['pacman', ['-Q', 'agent-teams-ai']],
  }[kind] as [string, string[]];
  const list = {
    deb: ['dpkg-query', ['-L', 'agent-teams-ai']],
    rpm: ['rpm', ['-ql', 'agent-teams-ai']],
    pacman: ['pacman', ['-Qlq', 'agent-teams-ai']],
  }[kind] as [string, string[]];
  const version = await execute(query[0], [...query[1]], { env: tools, timeout: 10_000 });
  const files = await execute(list[0], [...list[1]], { env: tools, timeout: 10_000 });
  const candidates = files.stdout
    .split('\n')
    .filter((file) => file.startsWith('/opt/') && file.endsWith('/agent-teams-ai'));
  assert.equal(candidates.length, 1, 'Native manager must identify one installed Electron payload');
  const executable = candidates[0];
  assert(executable);
  const raw = version.stdout.trim();
  const value =
    kind === 'pacman' ? raw.split(/\s+/)[1]?.replace(/-\d+$/, '') : raw.replace(/-\d+$/, '');
  assert(value);
  return {
    version: value,
    executable: await readlink(executable).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'EINVAL') return executable;
      throw error;
    }),
    query: { command: query, ...version },
    list: { command: list, ...files },
  };
}
export async function installedProof(
  kind: PackageKind,
  version: string,
  referenceRoot: string,
  directory: string
) {
  await mkdir(directory, { recursive: true });
  const database = await packageDatabase(kind);
  assert.equal(database.version, version);
  const base = path.dirname(database.executable);
  const resources = path.join(base, 'resources');
  const entries = [
    'agent-teams-ai',
    'chrome-sandbox',
    'resources/app.asar',
    'resources/app-update.yml',
    'resources/package-type',
  ];
  const payload = [];
  for (const relative of entries) {
    const installed = path.join(base, relative);
    const reference = path.join(referenceRoot, version, path.relative('/', installed));
    const actual = await hashFile(installed);
    const expected = await hashFile(reference);
    assert.deepEqual(
      actual,
      expected,
      `Installed payload differs from immutable official ${version} package: ${relative}`
    );
    payload.push({ relative, ...actual });
  }
  assert.equal((await readFile(path.join(resources, 'package-type'), 'utf8')).trim(), kind);
  const configBytes = await readFile(path.join(resources, 'app-update.yml'));
  const config = parse(configBytes.toString()) as {
    owner: string;
    repo: string;
    provider: string;
    releaseType?: string;
  };
  assert.equal(`${config.owner}/${config.repo}`, repository);
  assert.equal(config.provider, 'github');
  assert.equal(config.releaseType, 'release');
  const sandbox = await stat(path.join(base, 'chrome-sandbox'));
  assert.equal(sandbox.uid, 0);
  assert.equal(
    sandbox.mode & 0o4777,
    0o4755,
    'Official install must set the root-owned Chromium sandbox helper'
  );
  const handle = Buffer.alloc(20);
  const executableFile = await open(database.executable, 'r');
  try {
    assert.equal((await executableFile.read(handle, 0, 20, 0)).bytesRead, 20);
  } finally {
    await executableFile.close();
  }
  assert.equal(handle.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(handle[4], 2);
  assert.equal(handle.readUInt16LE(18), 62, 'Native ELF x64 required');
  const fuse = await readInspectorFuse(database.executable);
  const archive = path.join(resources, 'app.asar');
  const source = await readAsar(archive, ['package.json', 'dist-electron/main/index.cjs']);
  const metadata = source.get('package.json');
  const main = source.get('dist-electron/main/index.cjs');
  assert(metadata && main);
  const pkg = JSON.parse(metadata.toString()) as { version: string; main: string; type?: string };
  assert.equal(pkg.version, version);
  assert.equal(pkg.main, 'dist-electron/main/index.cjs');
  // Node treats the explicit .cjs entry as CommonJS even with type: module.
  // pausedEntry also verifies this exact entry in the owned native process.
  await writeFile(path.join(directory, 'app-update.yml'), configBytes);
  // Source capture proves actual packaged implementations; runtime class and
  // observed install behavior below provide the behavioral gate.
  const ledger = await captureSources(archive, directory);
  return {
    database,
    resources,
    payload,
    package: pkg,
    fuse,
    sandbox: { uid: sandbox.uid, mode: (sandbox.mode & 0o7777).toString(8) },
    sourceLedger: ledger,
    mainSha256: digest(main),
  };
}
async function exactCandidate(pid: number, executable: string, minimumStart: string) {
  if ((await stat(`/proc/${pid}`).catch(() => null))?.uid !== process.getuid?.()) return null;
  const candidate = await readlink(`/proc/${pid}/exe`).catch((error) => {
    if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  });
  if (candidate !== executable && candidate !== `${executable} (deleted)`) return null;
  const identity = await processIdentity(pid);
  if (!identity || identity.state === 'Z' || BigInt(identity.start) < BigInt(minimumStart))
    return null;
  return { identity, executable: candidate };
}
async function processFile(pid: number, name: 'cmdline' | 'status') {
  return readFile(`/proc/${pid}/${name}`, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}
export async function ownedPackageApps(
  executable: string,
  roots: { home: string; userData: string },
  minimumStart: string
) {
  const result: OwnedPackageApp[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const candidate = await exactCandidate(pid, executable, minimumStart);
    if (!candidate) continue;
    const identity = candidate.identity;
    // Only exact installed TEST binary candidates are eligible for env reads.
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!environment) continue;
    const env = new Map(
      environment.split('\0').map((item) => {
        const index = item.indexOf('=');
        return [item.slice(0, index), item.slice(index + 1)];
      })
    );
    if (
      env.get('HOME') !== roots.home ||
      env.get('AGENT_TEAMS_ELECTRON_USER_DATA_DIR') !== roots.userData
    )
      continue;
    const rawCommand = await processFile(pid, 'cmdline');
    if (rawCommand === null) continue;
    const command = rawCommand.split('\0').filter(Boolean);
    if (command.some((argument) => argument.startsWith('--type='))) continue;
    const current = await processIdentity(pid);
    if (current?.start !== identity.start) continue;
    assert(
      !command.some((argument) => /^--no-sandbox(?:=|$)/.test(argument)),
      'Actual package app disabled Chromium sandbox'
    );
    result.push({ ...current, executable: candidate.executable, command });
  }
  return result;
}
async function unchangedMain(candidate: Identity, executable: string) {
  const current = await processIdentity(candidate.pid);
  assert(current && current.state !== 'Z', 'Owned main process exited');
  assert.equal(current.start, candidate.start, 'Owned main PID was reused');
  assert.equal(current.group, candidate.group, 'Owned main group changed');
  assert.equal(await readlink(`/proc/${candidate.pid}/exe`), executable);
  return current;
}
function kernelField(status: string, key: string) {
  const line = status.split('\n').find((value) => value.startsWith(`${key}:`));
  assert(line, `Kernel status lacks ${key}`);
  return line.slice(key.length + 1).trim();
}
function noCapabilities(status: string) {
  for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'])
    assert.equal(BigInt(`0x${kernelField(status, key)}`), 0n, `TEST process has ${key}`);
}
function sandboxCommand(command: string[]) {
  assert(
    !command.some((argument) => /(?:^|\s)--no-sandbox(?:=|\s|$)/.test(argument)),
    'Owned Electron process disabled sandbox'
  );
}
async function kernelProcess(pid: number, candidate: Identity, executable: string) {
  const identity = await processIdentity(pid);
  assert(identity && identity.state !== 'Z', 'Electron-associated process exited');
  assert.equal(identity.group, candidate.group, 'Electron-associated process escaped TEST group');
  assert(BigInt(identity.start) >= BigInt(candidate.start), 'Process predates exact TEST main');
  if (pid === candidate.pid)
    assert.equal(identity.start, candidate.start, 'Owned main PID was reused');
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const uid = kernelField(status, 'Uid').split(/\s+/).map(Number);
  assert(
    uid?.length === 4 && uid.every((value) => value === process.getuid?.()),
    'Kernel UID differs from TEST user'
  );
  assert.equal(
    await readlink(`/proc/${pid}/exe`),
    executable,
    'Process is not the installed TEST Electron'
  );
  const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  // Chromium can retain zygote argv or flatten rewritten argv into one string.
  sandboxCommand(command);
  const current = await processIdentity(pid);
  assert.equal(current?.start, identity.start, 'Associated PID was reused during kernel read');
  assert.equal(current?.group, identity.group);
  return {
    identity,
    command,
    parent: Number(kernelField(status, 'PPid')),
    namespacePids: kernelField(status, 'NSpid').split(/\s+/).map(Number),
    filters: Number(kernelField(status, 'Seccomp_filters')),
    status,
  };
}
async function ownedSandboxCommands(group: Identity) {
  const peers = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if ((await stat(`/proc/${pid}`).catch(() => null))?.uid !== process.getuid?.()) continue;
    const identity = await processIdentity(pid);
    if (!identity || identity.state === 'Z' || identity.group !== group.group) continue;
    assert(BigInt(identity.start) >= BigInt(group.start), 'Owned group member predates launch');
    const raw = await processFile(pid, 'cmdline');
    if (raw === null) continue;
    const command = raw.split('\0').filter(Boolean);
    sandboxCommand(command);
    const current = await processIdentity(pid);
    if (!current) continue;
    assert.equal(current.start, identity.start, 'Owned group member PID was reused');
    assert.equal(current.group, identity.group);
    peers.push({ identity, command });
  }
  assert(peers.length, 'Owned native app group disappeared');
  return peers;
}
export async function rendererSandbox(
  group: Identity,
  candidate: Identity,
  windows: WindowProcess[]
) {
  assert.equal(candidate.group, group.group);
  assert(BigInt(candidate.start) >= BigInt(group.start));
  const executable = await readlink(`/proc/${candidate.pid}/exe`);
  await unchangedMain(candidate, executable);
  const main = await kernelProcess(candidate.pid, candidate, executable);
  const harnessStatus = await readFile('/proc/self/status', 'utf8');
  const inheritedFilters = Number(/^Seccomp_filters:\s+(\d+)$/m.exec(harnessStatus)?.[1]);
  assert(Number.isSafeInteger(inheritedFilters), 'Kernel must expose actual seccomp filter counts');
  assert(
    windows.length && windows.every((window) => window.sandbox === true),
    'All actual Electron windows must enable sandbox'
  );
  const processes = [];
  for (const window of windows) {
    assert(
      Number.isSafeInteger(window.pid) && window.pid > 1 && window.pid !== candidate.pid,
      'Invalid actual renderer PID'
    );
    assert(Number.isSafeInteger(window.windowId) && window.windowId > 0);
    assert(Number.isSafeInteger(window.contentsId) && window.contentsId > 0);
    const renderer = await kernelProcess(window.pid, candidate, executable);
    assert(
      /^Seccomp:\s+2$/m.test(renderer.status) && renderer.filters > inheritedFilters,
      'Actual renderer must add Chromium seccomp filters beyond Docker'
    );
    assert(/^NoNewPrivs:\s+1$/m.test(renderer.status), 'Renderer must enforce no new privileges');
    noCapabilities(renderer.status);
    assert(
      main.namespacePids.length &&
        renderer.namespacePids.length > main.namespacePids.length &&
        renderer.namespacePids.every(Number.isSafeInteger),
      'Renderer must occupy a nested kernel PID namespace'
    );
    const ancestry = [renderer];
    while (ancestry.at(-1)?.identity.pid !== candidate.pid) {
      const previous = ancestry.at(-1);
      assert(
        previous && ancestry.length < 16 && previous.parent > 1,
        'Renderer ancestry does not reach exact TEST main'
      );
      assert(
        !ancestry.some((row) => row.identity.pid === previous.parent),
        'Renderer ancestry cycle'
      );
      const parent = await kernelProcess(previous.parent, candidate, executable);
      assert(BigInt(parent.identity.start) <= BigInt(previous.identity.start));
      ancestry.push(parent);
    }
    await unchangedMain(candidate, executable);
    assert.equal((await processIdentity(window.pid))?.start, renderer.identity.start);
    processes.push({ window, ...renderer, ancestry });
  }
  const peers = await ownedSandboxCommands(group);
  await unchangedMain(candidate, executable);
  return {
    inheritedFilters,
    main,
    processes,
    peers,
    association: 'Original Electron webContents.getOSProcessId plus kernel ancestry',
    sandboxEnabled: true,
  };
}
export async function lateWindowObservation(
  group: Identity,
  candidate: Identity,
  expected: {
    executable: string;
    version: string;
    resources: string;
    userData: string;
  }
) {
  // Caller records automatic native paint/package/profile BEFORE this read.
  // This cannot restart the app or install hooks in its updater/provider.
  await unchangedMain(candidate, expected.executable);
  const command = (await readFile(`/proc/${candidate.pid}/cmdline`, 'utf8'))
    .split('\0')
    .filter(Boolean);
  const retained = command.find((argument) => argument.startsWith('--inspect-brk='));
  let port = 9229;
  if (retained) {
    const match = /^--inspect-brk=127\.0\.0\.1:(\d+)$/.exec(retained);
    assert(match, 'Retained Inspector must bind explicit loopback');
    port = Number(match[1]);
    assert(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  }
  const fuse = await readInspectorFuse(expected.executable);
  if (!retained) {
    const { status } = await kernelProcess(candidate.pid, candidate, expected.executable);
    noCapabilities(status);
    const caught = /^SigCgt:\s+([a-f\d]+)$/im.exec(status)?.[1];
    assert(
      caught && (BigInt(`0x${caught}`) & (1n << 9n)) !== 0n,
      'Original app does not catch SIGUSR1'
    );
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        reject(new Error('Late Inspector port is already occupied'));
      });
      socket.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve();
        else reject(error);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error('Late Inspector port preflight timed out'));
      });
    });
    noCapabilities((await kernelProcess(candidate.pid, candidate, expected.executable)).status);
    await unchangedMain(candidate, expected.executable);
    process.kill(candidate.pid, 'SIGUSR1');
  }
  const target = await waitFor(
    async () => {
      await unchangedMain(candidate, expected.executable);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(500),
        });
        if (!response.ok) return null;
        return (
          ((await response.json()) as { type: string; webSocketDebuggerUrl: string }[]).find(
            (row) => row.type === 'node' && row.webSocketDebuggerUrl
          ) ?? null
        );
      } catch {
        return null;
      }
    },
    'same automatic PID read-only Inspector',
    10_000
  );
  const connection = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    assert.equal(
      await connection.evaluate('process.pid'),
      candidate.pid,
      'Inspector belongs to another process'
    );
    const expression = `(() => {const electron=process.mainModule.require('electron');return {pid:process.pid,version:electron.app.getVersion(),executable:process.execPath,resources:process.resourcesPath,userData:electron.app.getPath('userData'),entry:process.mainModule.filename,windows:electron.BrowserWindow.getAllWindows().map(window=>({windowId:window.id,contentsId:window.webContents.id,pid:window.webContents.getOSProcessId(),sandbox:window.webContents.getLastWebPreferences().sandbox}))};})()`;
    const actual = await connection.evaluate<{
      pid: number;
      version: string;
      executable: string;
      resources: string;
      userData: string;
      entry: string;
      windows: WindowProcess[];
    }>(expression);
    assert.equal(actual.pid, candidate.pid, 'Inspector belongs to another process');
    for (const key of ['version', 'executable', 'resources', 'userData'] as const)
      assert.equal(actual[key], expected[key]);
    assert.equal(
      actual.entry,
      path.join(expected.resources, 'app.asar/dist-electron/main/index.cjs')
    );
    const sandbox = await rendererSandbox(group, candidate, actual.windows);
    assert.deepEqual(
      await connection.evaluate(expression),
      actual,
      'Actual Electron window association changed during kernel proof'
    );
    const identity = await unchangedMain(candidate, expected.executable);
    return {
      phase: 'Read-only association after automatic native paint',
      method: retained ? 'retained-inspector' : 'SIGUSR1',
      fuse,
      port,
      identity,
      actual,
      sandbox,
    };
  } finally {
    connection.close();
  }
}
export async function desktopProof(owner: Identity, directory: string, candidate = owner) {
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + 45_000;
  const native = await captureNativeWindow(owner, directory);
  assert.equal(native.identity.pid, candidate.pid, 'OS window belongs to exact main PID');
  const attempts = [];
  const env = {
    ...tools,
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    OMP_THREAD_LIMIT: '1',
  };
  while (Date.now() < deadline) {
    const current = await processIdentity(candidate.pid);
    assert.equal(current?.start, candidate.start);
    assert.equal(current?.group, owner.group);
    const property = await execute('/usr/bin/xprop', ['-id', native.id, '_NET_WM_PID'], {
      env,
      timeout: 5000,
    });
    assert.equal(Number(/=\s*(\d+)/.exec(property.stdout)?.[1]), native.identity.pid);
    const window = await execute('/usr/bin/xwininfo', ['-id', native.id, '-stats'], {
      env,
      timeout: 5000,
    });
    assert(/Map State:\s*IsViewable/.test(window.stdout));
    const image = path.join(directory, `paint-${attempts.length + 1}.png`);
    await execute('/usr/bin/import', ['-window', native.id, image], { env, timeout: 5000 });
    const ocr = await execute('/usr/bin/tesseract', [image, 'stdout', '--psm', '11'], {
      env,
      timeout: 5000,
    });
    await writeFile(`${image}.ocr.txt`, ocr.stdout);
    await writeFile(`${image}.stderr.txt`, ocr.stderr);
    const hash = await hashFile(image);
    const ready =
      /Providers\s*&\s*plans/i.test(ocr.stdout) &&
      /\bTasks\b/.test(ocr.stdout) &&
      !/Preparing\s+workspace|splash/i.test(ocr.stdout);
    attempts.push({ image, sha256: hash.sha256, ocrSha256: digest(ocr.stdout), ...ocr, ready });
    const after = await processIdentity(candidate.pid);
    assert.equal(after?.start, candidate.start);
    assert.equal(after?.group, owner.group);
    if (ready) {
      await copyFile(image, native.screenshot);
      return { ...native, attempts, ready };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await writeFile(path.join(directory, 'paint-attempts.json'), JSON.stringify(attempts, null, 2));
  throw new Error(
    'Actual native package desktop failed to paint Providers & plans and Tasks within 45 seconds'
  );
}
