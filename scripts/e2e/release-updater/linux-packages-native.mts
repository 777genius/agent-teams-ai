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
import { promisify } from 'node:util';
import { parse } from 'yaml';

import { captureSources, readAsar, readInspectorFuse } from './archive.mts';
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
  assert(!pkg.type || pkg.type === 'commonjs');
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
export async function rendererSandbox(group: Identity, candidate: Identity) {
  const processes = [];
  const harnessStatus = await readFile('/proc/self/status', 'utf8');
  const inheritedFilters = Number(/^Seccomp_filters:\s+(\d+)$/m.exec(harnessStatus)?.[1]);
  assert(Number.isSafeInteger(inheritedFilters), 'Kernel must expose actual seccomp filter counts');
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if ((await stat(`/proc/${pid}`).catch(() => null))?.uid !== process.getuid?.()) continue;
    const identity = await processIdentity(pid);
    if (
      !identity ||
      identity.state === 'Z' ||
      identity.group !== group.group ||
      BigInt(identity.start) < BigInt(group.start)
    )
      continue;
    // The exact TEST launch group is established before any command/status read.
    const rawCommand = await processFile(pid, 'cmdline');
    if (rawCommand === null) continue;
    const command = rawCommand.split('\0').filter(Boolean);
    assert(
      !command.some((argument) => /^--no-sandbox(?:=|$)/.test(argument)),
      'Owned Electron process disabled sandbox'
    );
    if (!command.includes('--type=renderer')) continue;
    const status = await processFile(pid, 'status');
    if (status === null) continue;
    const filters = Number(/^Seccomp_filters:\s+(\d+)$/m.exec(status)?.[1]);
    assert(
      /^Seccomp:\s+2$/m.test(status) && filters > inheritedFilters,
      'Actual renderer must add Chromium seccomp filters beyond Docker'
    );
    processes.push({
      identity,
      command,
      status: status.split('\n').filter((line) => /^Uid|^Cap|^Seccomp|^NoNewPrivs/.test(line)),
      filters,
    });
  }
  assert(processes.length, 'No actual sandboxed renderer associated with TEST app group');
  const current = await processIdentity(candidate.pid);
  assert.equal(current?.start, candidate.start);
  assert.equal(current?.group, group.group);
  return { inheritedFilters, processes, sandboxEnabled: true };
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
      return { ...native, attempts, ready, sandbox: await rendererSandbox(owner, candidate) };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await writeFile(path.join(directory, 'paint-attempts.json'), JSON.stringify(attempts, null, 2));
  throw new Error(
    'Actual native package desktop failed to paint Providers & plans and Tasks within 45 seconds'
  );
}
