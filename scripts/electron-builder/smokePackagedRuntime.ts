import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DefaultProcessLedger,
  stopUnregisteredApp,
} from '../e2e/anthropic-compatible-status/packaged-default-processes.ts';
import { verifyExternalOpenCodeV2Base } from '../lib/opencode-v2-base-inventory.mts';
import { smokeExternalOpenCodeV2Base } from './smokeExternalOpenCodeV2Base.ts';

const require = createRequire(import.meta.url);
const nativePolicy = require('./afterPack.cjs')._internal as {
  detectBinaryMetadata(file: string): Promise<{ format: string; archs: Set<string> } | null>;
  isBinaryCompatible(format: string, archs: Set<string>, platform: string, arch: string): boolean;
};
const repoRoot = path.resolve(import.meta.dirname, '../..');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const successPrefix = 'PACKAGED_RUNTIME_OK ';

// bun-pty 0.4.11 npm SRI-verified release bytes. A different native build must be reviewed.
export const nativeTargets: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': {
    file: 'librust_pty_arm64.dylib',
    sha256: '280ee7412cf45bb77587fed9d757ec5826408b44fd27f136d69dd1a86f3b83fc',
  },
  'darwin-x64': {
    file: 'librust_pty.dylib',
    sha256: '8c2634bbe4666df5d73bc8982d0dcaabeadd3dc57095b2986a28648dec03a947',
  },
  'linux-x64': {
    file: 'librust_pty.so',
    sha256: 'd7bee8bb1321339b80523467314d4153a1c8b1f779fc8913254935760b8274ee',
  },
  'win32-x64': {
    file: 'rust_pty.dll',
    sha256: '0cd0a5124fa6a924329cec8ca74067b268e5f773a0107cc2a792a070f9f3cfe2',
  },
  'win32-arm64': {
    file: 'rust_pty_arm64.dll',
    sha256: '80c44d8cb5123b95494fdb785fe7e2716a5c1f9a57c5d890e469ffc046bddb98',
  },
};

export function containedFile(root: string, file: string) {
  const physicalRoot = fs.realpathSync(root);
  assert(fs.lstatSync(file).isFile(), `Runtime file is not regular: ${file}`);
  const physical = fs.realpathSync(file);
  const relative = path.relative(physicalRoot, physical);
  assert(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `Runtime file escaped its root: ${file}`
  );
  return {
    path: physical,
    sha256: createHash('sha256').update(fs.readFileSync(physical)).digest('hex'),
  };
}

export function containedDirectory(root: string, directory: string) {
  const physicalRoot = fs.realpathSync(root);
  assert(fs.lstatSync(directory).isDirectory(), `Runtime directory is not regular: ${directory}`);
  const physical = fs.realpathSync(directory);
  const relative = path.relative(physicalRoot, physical);
  assert(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `Runtime directory escaped its root: ${directory}`
  );
  return physical;
}

export function runtimeEnvironment(parent: NodeJS.ProcessEnv, project: string) {
  const owned: Record<string, string> = {
    HOME: project,
    USERPROFILE: project,
    APPDATA: path.join(project, 'appdata'),
    LOCALAPPDATA: path.join(project, 'localappdata'),
    XDG_CONFIG_HOME: path.join(project, 'config'),
    XDG_CACHE_HOME: path.join(project, 'cache'),
    XDG_STATE_HOME: path.join(project, 'state'),
    TEMP: path.join(project, 'tmp'),
    TMP: path.join(project, 'tmp'),
    TMPDIR: path.join(project, 'tmp'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(project, 'bun-cache'),
  };
  const hooks = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'BUN_OPTIONS',
    'BUN_PRELOAD',
    'BUN_INSPECT',
    'ELECTRON_RUN_AS_NODE',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'MSGPACKR_NATIVE_ACCELERATION_DISABLED',
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    const upper = key.toUpperCase();
    if (
      value !== undefined &&
      !hooks.has(upper) &&
      !upper.startsWith('BUN_PTY_') &&
      !Object.hasOwn(owned, upper)
    )
      env[key] = value;
  }
  for (const directory of Object.values(owned)) fs.mkdirSync(directory, { recursive: true });
  return { ...env, ...owned };
}

export function stagedFile(runtime: string, staged: string, relative: string) {
  const bundled = containedFile(runtime, path.join(runtime, relative));
  const source = containedFile(staged, path.join(staged, relative));
  assert.equal(
    bundled.sha256,
    source.sha256,
    `Bundled runtime differs from staged bytes: ${relative}`
  );
  return bundled;
}

async function compatible(file: string) {
  const metadata = await nativePolicy.detectBinaryMetadata(file);
  assert(
    metadata &&
      nativePolicy.isBinaryCompatible(
        metadata.format,
        metadata.archs,
        process.platform,
        process.arch
      ),
    `Incompatible runtime native file: ${file}`
  );
  return { format: metadata.format, archs: [...metadata.archs].sort() };
}

function packageAt(entry: string, name: string, runtime: string) {
  containedFile(runtime, entry);
  for (
    let directory = path.dirname(entry);
    directory !== path.dirname(directory);
    directory = path.dirname(directory)
  ) {
    const candidate = path.join(directory, 'package.json');
    if (!fs.existsSync(candidate)) continue;
    const identity = containedFile(runtime, candidate);
    const manifest = JSON.parse(fs.readFileSync(identity.path, 'utf8')) as {
      name: string;
      version: string;
    };
    assert.equal(manifest.name, name, `Unexpected package context for ${entry}`);
    return { root: fs.realpathSync(directory), version: manifest.version, manifest: identity };
  }
  throw new Error(`Missing package identity: ${name}`);
}

export interface StagedOpenCodeV2Graph {
  version: string;
  server: string;
}

/** The runtime's own staging manifest lists every graph it ships; nothing is repeated here. */
export function stagedOpenCodeV2Graphs(runtime: string): {
  graphs: StagedOpenCodeV2Graph[];
  pty: string;
} {
  const manifest = JSON.parse(
    fs.readFileSync(
      containedFile(runtime, path.join(runtime, 'local-cli/opencode-v2-graphs.json')).path,
      'utf8'
    )
  ) as { schema?: unknown; graphs?: unknown; pty?: unknown };
  assert.equal(manifest.schema, 2, 'Unsupported OpenCode V2 graph manifest');
  assert(
    Array.isArray(manifest.graphs) && manifest.graphs.length > 0,
    'No staged OpenCode V2 graph'
  );
  assert(
    typeof manifest.pty === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.pty),
    'Invalid staged PTY pin'
  );
  const graphs = manifest.graphs.map((value: unknown) => {
    const graph = value as Partial<StagedOpenCodeV2Graph>;
    assert(
      typeof graph.version === 'string' &&
        /^\d+\.\d+\.\d+$/.test(graph.version) &&
        graph.server === `@opencode/server-v${graph.version}`,
      'Invalid staged OpenCode V2 graph'
    );
    return { version: graph.version, server: graph.server };
  });
  return { graphs, pty: manifest.pty };
}

export function serverIdentity(entry: string, graph: StagedOpenCodeV2Graph, runtime: string) {
  // npm aliases keep the original package name in their physical package.json.
  const identity = packageAt(entry, '@opencode/server', runtime);
  assert.equal(identity.version, graph.version, 'Wrong server graph version');
  return identity;
}

export function deliveryIdentity(
  value: unknown,
  platform: string,
  arch: string,
  bunSha256: string,
  entrySha256: string
) {
  assert(value && typeof value === 'object', 'Missing runtime delivery identity');
  const identity = value as Record<string, unknown>;
  assert.equal(identity.schema, 1);
  assert.equal(identity.platform, platform);
  assert.equal(identity.arch, arch);
  assert.equal(identity.bunVersion, platform === 'win32' ? '1.4.3' : '1.3.11');
  assert.match(bunSha256, /^[a-f0-9]{64}$/);
  assert.match(entrySha256, /^[a-f0-9]{64}$/);
  assert.equal(identity.bunSha256, bunSha256, 'Declared Bun identity differs from physical bytes');
  assert.equal(
    identity.entrySha256,
    entrySha256,
    'Declared entry identity differs from physical bytes'
  );
  return identity;
}

interface Pty {
  pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: string | number }) => void): {
    dispose(): void;
  };
  kill(): void;
}
export function assertNaturalPtyResult(result: {
  output: string;
  marker: string;
  exitCode?: number;
  signal?: string | number;
  forcedCleanup: boolean;
  childGone: boolean;
}) {
  assert.equal(result.forcedCleanup, false, 'PTY cleanup cannot qualify as natural exit');
  assert.equal(result.exitCode, 0, 'PTY did not exit successfully');
  assert.equal(result.signal, undefined, 'PTY exited with a signal');
  assert(result.output.includes(result.marker), 'PTY marker was not observed');
  assert.equal(result.childGone, true, 'PTY child is still running');
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function waitGone(pid: number) {
  for (let i = 0; i < 50 && alive(pid); i++) await pause(50);
  return !alive(pid);
}

async function waitForOwnedFile(project: string, name: string) {
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(path.join(project, name))) return;
    await pause(50);
  }
  throw new Error(`Owned smoke coordination timed out: ${name}`);
}

export async function provePty(
  adapter: { spawn(file: string, args: string[], options: Record<string, unknown>): Pty },
  project: string
) {
  const marker = `owned-runtime-pty-${randomUUID()}`;
  const windows = process.platform === 'win32';
  const shell = windows
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
    : '/bin/sh';
  const args = windows
    ? ['/d', '/s', '/c', `echo ${marker}`]
    : ['-c', `printf '%s\\n' '${marker}'`];
  const child = adapter.spawn(shell, args, { cwd: project, env: process.env, cols: 80, rows: 24 });
  assert(
    Number.isInteger(child.pid) && child.pid > 0 && child.pid !== process.pid,
    'Invalid owned PTY PID'
  );
  let output = '',
    outputExceeded = false,
    forcedCleanup = false,
    exit: { exitCode: number; signal?: string | number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let data: { dispose(): void } | undefined, exited: { dispose(): void } | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      data = child.onData((chunk) => {
        if (output.length + chunk.length > 65536) {
          outputExceeded = true;
          reject(new Error('PTY output exceeded bound'));
          return;
        }
        output += chunk;
      });
      exited = child.onExit((event) => {
        exit = event;
        resolve();
      });
      timer = setTimeout(() => reject(new Error('PTY natural exit timed out')), 10000);
    });
    clearTimeout(timer);
    const childGone = await waitGone(child.pid);
    assert.equal(outputExceeded, false, 'PTY output exceeded bound after natural exit');
    assertNaturalPtyResult({ output, marker, ...exit, forcedCleanup, childGone });
    const natural = Object.freeze({
      pid: child.pid,
      marker,
      output,
      ...exit,
      childGone,
      forcedCleanup,
    });
    // Natural exit does not release bun-pty's retained native terminal handle.
    // Its kill() emits synthetic exit0: listeners are disposed and immutable
    // natural/PID-gone evidence is frozen BEFORE releasing the retired handle.
    data?.dispose();
    exited?.dispose();
    data = undefined;
    exited = undefined;
    child.kill();
    return { ...natural, postNaturalRelease: true };
  } catch (error) {
    forcedCleanup = true; // kill() itself synthesizes exitCode 0: failure is already permanent.
    data?.dispose();
    exited?.dispose();
    child.kill();
    assert(await waitGone(child.pid), 'Owned PTY child survived failure cleanup');
    throw error;
  } finally {
    clearTimeout(timer);
    data?.dispose();
    exited?.dispose();
  }
}

async function probe(runtime: string, staged: string, project: string, expectedBun: string) {
  const bun = (
    globalThis as unknown as {
      Bun?: { version: string; resolveSync(specifier: string, directory: string): string };
    }
  ).Bun;
  assert(bun, 'Runtime probe must execute using bundled Bun');
  assert.equal(bun.version, process.platform === 'win32' ? '1.4.3' : '1.3.11');
  const executable = containedFile(runtime, process.execPath);
  assert.equal(
    executable.sha256,
    expectedBun,
    'Actual process executable differs from bundled Bun'
  );
  assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(project));
  assert.equal(fs.realpathSync(process.env.HOME!), fs.realpathSync(project));
  for (const key of Object.keys(process.env))
    assert(
      !key.toUpperCase().startsWith('BUN_PTY_') &&
        !['NODE_OPTIONS', 'BUN_OPTIONS', 'MSGPACKR_NATIVE_ACCELERATION_DISABLED'].includes(
          key.toUpperCase()
        ),
      `Forbidden runtime override: ${key}`
    );
  const target = nativeTargets[`${process.platform}-${process.arch}`];
  assert(target, 'Unsupported runtime smoke platform');
  const graphs = [];
  const stagedGraphs = stagedOpenCodeV2Graphs(runtime);
  for (const graph of stagedGraphs.graphs) {
    const { server, version } = graph;
    const serverEntry = fs.realpathSync(
      bun.resolveSync(`${server}/process`, path.join(runtime, 'local-cli'))
    );
    const serverPackage = serverIdentity(serverEntry, graph, runtime);
    const coreEntry = fs.realpathSync(
      bun.resolveSync('@opencode/core/bus', path.dirname(serverEntry))
    );
    const core = packageAt(coreEntry, '@opencode/core', runtime);
    assert.equal(core.version, version);
    const adapterEntry: string = fs.realpathSync(bun.resolveSync('#pty', path.dirname(coreEntry)));
    assert.equal(
      adapterEntry,
      fs.realpathSync(path.join(core.root, 'dist/pty/pty.bun.js')),
      'Wrong core PTY adapter'
    );
    const ptyEntry = fs.realpathSync(bun.resolveSync('bun-pty', path.dirname(adapterEntry)));
    const pty = packageAt(ptyEntry, 'bun-pty', runtime);
    assert.equal(pty.version, stagedGraphs.pty);
    const graphFiles = [
      serverEntry,
      serverPackage.manifest.path,
      coreEntry,
      core.manifest.path,
      adapterEntry,
      ptyEntry,
      pty.manifest.path,
      path.join(pty.root, 'src/terminal.ts'),
      path.join(pty.root, 'src/library.ts'),
    ].map((file) => stagedFile(runtime, staged, path.relative(runtime, file)));
    const relativeNative = path.relative(
      runtime,
      path.join(pty.root, 'rust-pty/target/release', target.file)
    );
    const native = stagedFile(runtime, staged, relativeNative);
    assert.equal(native.sha256, target.sha256, 'Unexpected bun-pty native release bytes');
    const nativeMetadata = await compatible(native.path);
    stagedFile(runtime, staged, path.relative(runtime, adapterEntry));
    const adapter = (await import(pathToFileURL(adapterEntry).href)) as {
      spawn: Parameters<typeof provePty>[0]['spawn'];
    };
    const terminal = await provePty(adapter, project);
    graphs.push({
      server,
      version,
      serverEntry,
      serverPackage,
      core,
      adapter: containedFile(runtime, adapterEntry),
      bunPty: pty,
      native,
      nativeMetadata,
      graphFiles,
      terminal,
    });
  }
  const msgpackrEntry = fs.realpathSync(
    bun.resolveSync('msgpackr', path.join(runtime, 'local-cli'))
  );
  const msgpackrPackage = packageAt(msgpackrEntry, 'msgpackr', runtime);
  assert.equal(msgpackrPackage.version, '2.1.0');
  stagedFile(runtime, staged, path.relative(runtime, msgpackrEntry));
  const msgpackr = (await import(pathToFileURL(msgpackrEntry).href)) as {
    pack(value: unknown): Uint8Array;
    unpack(value: Uint8Array): unknown;
    isNativeAccelerationEnabled: boolean;
  };
  const value = {
    unicode: 'Тест 世界 🧪',
    array: [0, -12, 1.5, true, null, ['nested']],
    binary: Buffer.from([0, 1, 127, 255]),
  };
  assert.deepEqual(
    msgpackr.unpack(msgpackr.pack(value)),
    value,
    'Normal-env msgpackr roundtrip failed'
  );
  if (process.platform === 'win32' && process.arch === 'arm64')
    assert.equal(
      msgpackr.isNativeAccelerationEnabled,
      false,
      'Windows ARM64 should use actual optional JS fallback'
    );
  return {
    bun: {
      ...executable,
      version: bun.version,
      platform: process.platform,
      arch: process.arch,
      metadata: await compatible(executable.path),
    },
    graphs,
    msgpackr: {
      ...msgpackrPackage,
      entry: containedFile(runtime, msgpackrEntry),
      isNativeAccelerationEnabled: msgpackr.isNativeAccelerationEnabled,
      roundtrip: true,
    },
  };
}

export async function runProbe(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  project: string
) {
  const ledger = new DefaultProcessLedger();
  const child = spawn(executable, args, {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '',
    outputExceeded = false,
    registered = false,
    positiveFinalized = false,
    timer: NodeJS.Timeout | undefined;
  let phase = 'registration';
  let evidence: unknown;
  let beforeExitCensus: ReturnType<DefaultProcessLedger['sample']> = [];
  let naturalExit: { code: number | null; signal: string | null } | undefined;
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Attach rejection handlers before OS inventory so early spawn errors stay owned.
  void closed.catch(() => {});
  const receipt = new Promise<unknown>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      if (stdout.length + text.length > 1048576) {
        outputExceeded = true;
        reject(new Error('Runtime probe output exceeded bound'));
        return;
      }
      stdout += text;
      const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(successPrefix));
      if (lines.length > 1) reject(new Error('Duplicate runtime probe receipt'));
      if (lines.length === 1 && stdout.endsWith('\n')) {
        try {
          resolve(JSON.parse(lines[0].slice(successPrefix.length)));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (stderr.length + text.length > 1048576) {
        outputExceeded = true;
        return;
      }
      stderr += text;
    });
    void closed.then(
      () => reject(new Error(`Runtime probe closed before receipt: ${stderr}`)),
      reject
    );
  });
  void receipt.catch(() => {});
  try {
    try {
      await ledger.register(child);
      registered = true;
    } catch (error) {
      await stopUnregisteredApp(child);
      throw error;
    }
    ledger.start();
    // Registration precedes PTY creation. Capture descendants while their owner
    // is alive, then let it return so owner-dependent helpers can retire too.
    fs.writeFileSync(path.join(project, 'runtime-start'), 'owned\n');
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Bundled runtime probe timed out')), 60000);
    });
    phase = 'probe';
    evidence = await Promise.race([receipt, deadline]);
    phase = 'before-owner-exit';
    beforeExitCensus = ledger.sample();
    const owner = ledger.roots[0];
    assert(
      owner &&
        beforeExitCensus.some((entry) => entry.pid === owner.pid && entry.birth === owner.birth),
      'Runtime owner exited before final identity capture'
    );
    fs.writeFileSync(path.join(project, 'runtime-exit'), 'owned\n');
    phase = 'natural-owner-exit';
    naturalExit = await Promise.race([closed, deadline]);
    assert.equal(naturalExit.code, 0, `Bundled runtime probe failed: ${stderr}`);
    assert.equal(naturalExit.signal, null);
    assert.equal(outputExceeded, false, 'Runtime probe output exceeded bound after receipt');
    assert.equal(stdout.split(/\r?\n/).filter((line) => line.startsWith(successPrefix)).length, 1);
    phase = 'natural-tree-retirement';
    const until = Date.now() + 5000;
    while (ledger.sample().length && Date.now() < until) await Promise.race([pause(100), deadline]);
    assert.equal(ledger.sample().length, 0, 'Runtime processes did not settle naturally');
    const naturalFinalization = await ledger.stop({ requireQuiet: true });
    positiveFinalized = true;
    return { evidence, beforeExitCensus, naturalExit, naturalFinalization };
  } catch (error) {
    let remaining: ReturnType<DefaultProcessLedger['sample']> | undefined;
    let inventoryError: string | undefined;
    try {
      if (registered) remaining = ledger.sample();
    } catch (failure) {
      inventoryError = String(failure);
    }
    // Retain the actual receipt and owned identities before failure-only cleanup.
    console.error(
      '[smokePackagedRuntime] FAILURE ' +
        JSON.stringify({
          phase,
          error: String(error),
          evidence,
          beforeExitCensus,
          naturalExit,
          remaining,
          observed: [...ledger.observed.values()],
          inventoryError,
        })
    );
    throw error;
  } finally {
    clearTimeout(timer);
    if (registered && !positiveFinalized) await ledger.stop();
  }
}

/**
 * A runtime released without OpenCode V2 ships only its compiled front door, which answers
 * every command itself; its pinned contract must then qualify no V2 version.
 */
export function smokeRuntimeWithoutOpenCodeV2(input: {
  runtime: string;
  frontdoor: { path: string; sha256: string };
  cliVersion: string;
  opencodeV2: { qualified?: Record<string, unknown> } | undefined;
}) {
  const qualified = Object.values(input.opencodeV2?.qualified ?? {});
  assert(
    qualified.length > 0 &&
      qualified.every((versions) => Array.isArray(versions) && versions.length === 0),
    'A runtime without OpenCode V2 delivery must not be pinned with qualified V2 versions'
  );
  for (const relative of ['local-cli', 'bun'])
    assert(
      !fs.existsSync(path.join(input.runtime, relative)),
      `Unexpected V2 delivery: ${relative}`
    );
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-TEST-')));
  try {
    const env = runtimeEnvironment(process.env, project);
    const run = (args: string[]) =>
      spawnSync(input.frontdoor.path, args, {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 4_194_304,
        windowsHide: true,
      });
    const version = run(['--version']);
    assert.equal(version.status, 0, `Front door --version failed: ${version.stderr}`);
    assert.equal(version.stdout.trim().split(/\s+/)[0], input.cliVersion);
    const status = run(['runtime', 'status', '--provider', 'opencode', '--json']);
    assert.equal(status.status, 0, `Front door runtime status failed: ${status.stderr}`);
    const payload = JSON.parse(status.stdout) as { schemaVersion?: unknown; providers?: object };
    assert(
      payload.schemaVersion === 2 && payload.providers && 'opencode' in payload.providers,
      'Front door did not answer runtime status'
    );
    return { cliVersion: input.cliVersion, runtimeStatus: 'served by the front door' };
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

export async function smokePackagedRuntime(bundle: string, platform: string) {
  assert.equal(platform, process.platform, 'Packaged runtime smoke must use the actual target OS');
  const platformKey = `${process.platform}-${process.arch}`;
  const runtime = containedDirectory(
    bundle,
    path.join(
      fs.realpathSync(bundle),
      ...(platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']),
      'runtime'
    )
  );
  const staged = containedDirectory(repoRoot, path.join(repoRoot, 'resources/runtime'));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtime.lock.json'), 'utf8')) as {
    version: string;
    cliVersion: string;
    assets: Record<string, { sha256: string; binaryName: string }>;
    opencodeV2?: { qualified?: Record<string, unknown> };
  };
  const asset = lock.assets[platformKey];
  assert(asset && /^[a-f0-9]{64}$/.test(asset.sha256), 'Missing immutable runtime archive pin');
  assert.equal(
    fs.readFileSync(stagedFile(runtime, staged, 'VERSION').path, 'utf8').trim(),
    lock.version
  );
  const sourceCommit = fs
    .readFileSync(stagedFile(runtime, staged, 'COMMIT_SHA').path, 'utf8')
    .trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const frontdoor = stagedFile(runtime, staged, asset.binaryName);
  const externalSupport = verifyExternalOpenCodeV2Base(runtime, lock, platformKey);
  if (externalSupport) {
    verifyExternalOpenCodeV2Base(staged, lock, platformKey);
  }
  if (!fs.existsSync(path.join(runtime, 'opencode-delivery.json'))) {
    const evidence = smokeRuntimeWithoutOpenCodeV2({
      runtime,
      frontdoor,
      cliVersion: lock.cliVersion,
      opencodeV2: lock.opencodeV2,
    });
    console.log(
      `[smokePackagedRuntime] OK ${platform}: ${JSON.stringify({ runtimeVersion: lock.version, archiveSha256: asset.sha256, sourceCommit, frontdoor, openCodeV2: 'not shipped', evidence })}`
    );
    return;
  }
  const bunEntry = process.platform === 'win32' ? 'bun/bun.exe' : 'bun/bun';
  const executable = stagedFile(runtime, staged, bunEntry);
  const entry = stagedFile(runtime, staged, 'local-cli/cli.js');
  const deliveryFile = stagedFile(runtime, staged, 'opencode-delivery.json');
  const delivery = deliveryIdentity(
    JSON.parse(fs.readFileSync(deliveryFile.path, 'utf8')),
    process.platform,
    process.arch,
    executable.sha256,
    entry.sha256
  );
  await compatible(executable.path);
  if (externalSupport) {
    smokeExternalOpenCodeV2Base(frontdoor.path, runtimeEnvironment);
    console.log(
      `[smokePackagedRuntime] OK ${platform}: ${JSON.stringify({ runtimeVersion: lock.version, sourceCommit, frontdoor, delivery, openCodeV2: 'external support; base availability only, optional engine execution requires its separate smoke' })}`
    );
    return;
  }
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-TEST-')));
  let evidence: unknown;
  try {
    const env = runtimeEnvironment(process.env, project);
    fs.writeFileSync(path.join(project, '.test-only'), 'packaged-runtime-native-v1\n');
    evidence = await runProbe(
      executable.path,
      [
        '--no-env-file',
        fileURLToPath(import.meta.url),
        '--probe',
        runtime,
        staged,
        project,
        executable.sha256,
        process.platform,
        process.arch,
      ],
      env,
      project
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
  console.log(
    `[smokePackagedRuntime] OK ${platform}: ${JSON.stringify({ runtimeVersion: lock.version, archiveSha256: asset.sha256, sourceCommit, frontdoor, deliveryFile, delivery, entry, evidence, ownedChildrenRemaining: [] })}`
  );
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--probe') {
      const [runtime, staged, project, expectedBun, expectedPlatform, expectedArch] =
        process.argv.slice(3);
      assert(
        process.argv.length === 9 &&
          runtime &&
          staged &&
          project &&
          /^[a-f0-9]{64}$/.test(expectedBun)
      );
      assert.equal(process.platform, expectedPlatform, 'Bun process changed target platform');
      assert.equal(process.arch, expectedArch, 'Bun process changed target architecture');
      await waitForOwnedFile(project, 'runtime-start');
      console.log(
        successPrefix + JSON.stringify(await probe(runtime, staged, project, expectedBun))
      );
      await waitForOwnedFile(project, 'runtime-exit');
    } else {
      const [bundle, platform] = process.argv.slice(2);
      assert(
        bundle && platform && process.argv.length === 4,
        'Usage: smokePackagedRuntime.ts <bundle> <platform>'
      );
      await smokePackagedRuntime(bundle, platform);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
