import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { extractOpenCodePackage } from '../../../src/features/opencode-runtime-installer/main/infrastructure/packageExtraction';

import { acquire, metadata, sha256 } from './acquire.mts';
import { durable, observe, requireTerminal } from './observe.mts';

async function main(): Promise<void> {
  assert(process.env.GITHUB_ACTIONS === 'true', 'Physical qualification is CI-only');
  const target = `${process.platform}-${process.arch}`;
  assert.equal(
    target,
    process.env.SELECTION_TARGET,
    'Runner architecture must match target physically'
  );
  const packages: Record<string, string> = {
    'linux-x64': '@oven/bun-linux-x64',
    'darwin-x64': '@oven/bun-darwin-x64',
    'darwin-arm64': '@oven/bun-darwin-aarch64',
    'win32-x64': '@oven/bun-windows-x64',
    'win32-arm64': '@oven/bun-windows-aarch64',
  };
  const name = packages[target];
  assert(name, 'Unshipped target');
  const bunVersion = process.platform === 'win32' ? '1.4.3' : '1.3.11';
  const output = path.resolve('selection-evidence');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'TEST-selection-'));
  durable(path.join(root, 'scope.json'), {
    target,
    node: process.version,
    bunVersion,
    provenance: 'official standalone Bun toolchain version; not compiled/packaged runtime proof',
    pins: [
      { generation: 'v1', version: '1.18.34' },
      { generation: 'v2', version: '2.1.4' },
    ],
    packagedRuntimeQualified: false,
  });
  // No native probes have run. Only verified registry/tar acquisition occurs here.
  const bunMetadata = await metadata(name, bunVersion);
  const archive = await acquire(bunMetadata);
  const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const extracted = extractOpenCodePackage(archive, bunName, {
    packageName: name,
    version: bunVersion,
  });
  const bun = path.join(root, bunName);
  await writeFile(bun, extracted.binary, { flag: 'wx' });
  await chmod(bun, 0o755);
  const bunSha256 = sha256(extracted.binary);
  durable(path.join(root, 'bun-acquisition.json'), {
    metadata: bunMetadata,
    archiveSha256: sha256(archive),
    executableSha256: bunSha256,
    provenance: 'SRI-pinned npm vendor bytes; executable SHA fixed before execution',
  });
  const worker = path.resolve('selection-dist/worker.cjs');
  const workerSha256 = sha256(await readFile(worker));
  for (const [generation, version] of [
    ['v1', '1.18.34'],
    ['v2', '2.1.4'],
  ] as const) {
    for (const engine of ['node', 'bun'] as const) {
      const cwd = path.join(root, `${generation}-${engine}`);
      await mkdir(cwd);
      const home = path.join(cwd, 'TEST-home');
      await mkdir(home);
      const configRoots = {
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
      };
      await Promise.all(
        Object.values(configRoots).map((directory) => mkdir(directory, { recursive: true }))
      );
      const env: NodeJS.ProcessEnv = {
        GITHUB_ACTIONS: 'true',
        HOME: home,
        USERPROFILE: home,
        ...configRoots,
        TMPDIR: home,
        TMP: home,
        TEMP: home,
        AGENT_TEAMS_VITEST_TEMP_CLEANUP_DONE: '1',
      };
      for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
      assert.equal(sha256(await readFile(worker)), workerSha256);
      assert.equal(sha256(await readFile(bun)), bunSha256);
      // This is fsynced BEFORE spawning a worker that can resolve native CPU/ABI evidence.
      durable(path.join(cwd, 'execution-entry.json'), {
        entered: true,
        generation,
        version,
        target,
        engine,
        workerSha256,
        bunSha256,
      });
      const closure = await observe(
        engine === 'node' ? process.execPath : bun,
        [worker, generation, version, target],
        cwd,
        env,
        180_000,
        () => {
          try {
            durable(path.join(cwd, 'UNKNOWN.json'), {
              targetHalted: true,
              nativeClosed: false,
              reason: 'wrapper deadline, spawn error or output bound; exact close still observed',
            });
          } catch {
            process.stderr.write('UNKNOWN evidence write failed; target remains halted.\n');
          } finally {
            process.exitCode = 1;
          }
        }
      );
      durable(path.join(cwd, 'wrapper-close.json'), closure);
      let terminal: unknown;
      try {
        terminal = JSON.parse(readFileSync(path.join(cwd, 'terminal.json'), 'utf8'));
      } catch {
        /* Missing terminal is UNKNOWN, even with wrapper exit code zero. */
      }
      requireTerminal(closure, terminal);
      const proof = terminal as {
        engine: string;
        engineVersion: string;
        generation: string;
        version: string;
      };
      assert.equal(proof.generation, generation);
      assert.equal(proof.version, version);
      assert.equal(proof.engine, engine === 'bun' ? 'bun-standalone-toolchain' : 'node');
      assert.equal(proof.engineVersion, engine === 'bun' ? bunVersion : process.version);
    }
  }
  durable(path.join(root, 'selection-complete.json'), {
    target,
    passed: 4,
    packagedRuntimeQualified: false,
  });
}
main().catch(() => {
  // A post-entry failure is fatal for this target. No next pin, root-PID signal or UNKNOWN cleanup.
  process.stderr.write(
    'Selection target failed; inspect retained evidence. No continuation or cleanup.\n'
  );
  process.exitCode = 1;
});
