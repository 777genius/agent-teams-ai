import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { phase } from './runtime-bootstrap-diagnostics.mts';
import {
  assertSafeRuntimeZip,
  type ValidatedRuntimeZipEntry,
} from './runtime-archive-extraction.mts';
import { extractWindowsRuntimeZip } from './runtime-windows-zip-extraction.mts';
import { zipFixture } from './runtime-zip.test-fixture.mts';

function fixture(check: (root: string, archive: string, destination: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "TEST-Windows ZIP [x] 'тест'-"));
  try {
    const archive = path.join(root, "archive [x] 'тест'.zip");
    const destination = path.join(root, "destination [x] 'тест'");
    fs.mkdirSync(destination);
    fs.writeFileSync(archive, zipFixture([{ name: 'runtime/тест.txt', data: 'unicode bytes' }]));
    check(root, archive, destination);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('fixed Windows reader transports literal paths and validated facts through an exclusive private manifest', () => {
  fixture((root, archive, destination) => {
    const environment = { SystemRoot: 'C:\\Windows', TEST_INHERITED: 'retained' };
    const entries = assertSafeRuntimeZip(archive);
    let manifest = '';
    const run = (
      command: string,
      args: string[],
      options: import('node:child_process').SpawnSyncOptions
    ): void => {
      assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.deepEqual(args.slice(0, 4), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
      ]);
      const script = Buffer.from(args[4]!, 'base64').toString('utf16le');
      assert.ok(!script.includes(archive) && !script.includes(destination));
      assert.ok(script.includes('write ? 1U : 3U') && script.includes('MaxJsonLength = limit'));
      assert.equal(options.shell, false);
      assert.equal(options.env?.AGENT_TEAMS_RUNTIME_ZIP_ARCHIVE, archive);
      assert.equal(options.env?.AGENT_TEAMS_RUNTIME_ZIP_DESTINATION, destination);
      assert.equal(options.env?.TEST_INHERITED, 'retained');
      manifest = options.env?.AGENT_TEAMS_RUNTIME_ZIP_MANIFEST ?? '';
      assert.equal(path.dirname(manifest), root);
      assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), { version: 1, entries });
      if (process.platform !== 'win32') assert.equal(fs.statSync(manifest).mode & 0o7777, 0o600);
    };
    extractWindowsRuntimeZip(archive, destination, entries, environment, run);
    assert.equal(fs.existsSync(manifest), false);
    const error = new Error('TEST original native failure');
    assert.throws(
      () =>
        extractWindowsRuntimeZip(archive, destination, entries, environment, () => {
          throw error;
        }),
      (actual) => actual === error
    );
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      [path.basename(archive), path.basename(destination)].sort()
    );
    assert.deepEqual(environment, { SystemRoot: 'C:\\Windows', TEST_INHERITED: 'retained' });
    assert.throws(
      () => extractWindowsRuntimeZip(archive, destination, entries, {}, run),
      /absolute SystemRoot/u
    );
  });
});

test('manifest transport handles more than the Framework serializer default two MiB', () => {
  fixture((_root, archive, destination) => {
    const entries: ValidatedRuntimeZipEntry[] = Array.from({ length: 30000 }, (_, index) => ({
      name: `runtime/${index}-${'x'.repeat(64)}`,
      size: 0,
      compressedSize: 0,
      crc32: 0,
      directory: false,
    }));
    extractWindowsRuntimeZip(
      archive,
      destination,
      entries,
      { SystemRoot: 'C:\\Windows' },
      (_command, _args, options) => {
        const bytes = fs.readFileSync(options.env?.AGENT_TEAMS_RUNTIME_ZIP_MANIFEST ?? '');
        assert.ok(bytes.length > 2 * 1024 * 1024);
        const manifest = JSON.parse(bytes.toString()) as { entries: ValidatedRuntimeZipEntry[] };
        assert.equal(manifest.entries.length, entries.length);
        assert.deepEqual(manifest.entries.at(-1), entries.at(-1));
      }
    );
  });
});

function reorderedCentral(): Buffer {
  const bytes = zipFixture([
    { name: 'runtime/b', data: 'second' },
    { name: 'runtime/a', data: 'first' },
  ]);
  const offset = bytes.readUInt32LE(bytes.length - 6);
  const firstSize = 46 + bytes.readUInt16LE(offset + 28);
  return Buffer.concat([
    bytes.subarray(0, offset),
    bytes.subarray(offset + firstSize, bytes.length - 22),
    bytes.subarray(offset, offset + firstSize),
    bytes.subarray(bytes.length - 22),
  ]);
}

test('validated facts preserve central order while local-record validation follows physical order', () => {
  fixture((_root, archive) => {
    fs.writeFileSync(archive, reorderedCentral());
    assert.deepEqual(
      assertSafeRuntimeZip(archive).map((entry) => entry.name),
      ['runtime/a', 'runtime/b']
    );
  });
});

for (const scenario of [
  'valid Unicode',
  'central reorder',
  'CRC mismatch',
  'length mismatch',
  'name mismatch',
  'count mismatch',
  'existing output',
  'existing junction',
] as const) {
  test(
    `Windows inbox ZIP validates actual bytes and authority: ${scenario}`,
    { skip: process.platform !== 'win32' },
    () => {
      fixture((_root, archive, destination) => {
        if (scenario === 'central reorder') fs.writeFileSync(archive, reorderedCentral());
        if (scenario === 'CRC mismatch') {
          const bytes = fs.readFileSync(archive);
          bytes[30 + bytes.readUInt16LE(26)]! ^= 1;
          fs.writeFileSync(archive, bytes);
        }
        if (scenario === 'length mismatch') {
          const bytes = fs.readFileSync(archive);
          const central = bytes.readUInt32LE(bytes.length - 6);
          bytes.writeUInt32LE(bytes.readUInt32LE(22) - 1, 22);
          bytes.writeUInt32LE(bytes.readUInt32LE(central + 24) - 1, central + 24);
          fs.writeFileSync(archive, bytes);
        }
        let entries = assertSafeRuntimeZip(archive);
        if (scenario === 'name mismatch')
          entries = entries.map((entry) => ({ ...entry, name: 'runtime/different' }));
        if (scenario === 'count mismatch') entries = [];
        if (scenario === 'existing output') {
          fs.mkdirSync(path.join(destination, 'runtime'));
          fs.writeFileSync(path.join(destination, 'runtime/тест.txt'), 'preserved');
        }
        const outside = path.join(path.dirname(destination), 'outside');
        if (scenario === 'existing junction') {
          fs.mkdirSync(outside);
          fs.writeFileSync(path.join(outside, 'sentinel'), 'preserved');
          fs.symlinkSync(outside, path.join(destination, 'runtime'), 'junction');
        }
        let nativeCalls = 0;
        const run = (): void =>
          extractWindowsRuntimeZip(
            archive,
            destination,
            entries,
            process.env,
            (command, args, options) => {
              nativeCalls++;
              return execFileSync(command, args, { ...options, stdio: 'pipe' });
            }
          );
        if (scenario === 'valid Unicode' || scenario === 'central reorder') {
          run();
          assert.equal(
            fs.readFileSync(
              path.join(
                destination,
                scenario === 'valid Unicode' ? 'runtime/тест.txt' : 'runtime/a'
              ),
              'utf8'
            ),
            scenario === 'valid Unicode' ? 'unicode bytes' : 'first'
          );
        } else
          assert.throws(run, (error: unknown) => {
            assert.ok(error instanceof Error);
            const details = error.message + ('stderr' in error ? String(error.stderr) : '');
            if (scenario === 'CRC mismatch') assert.match(details, /CRC32/u);
            if (scenario === 'length mismatch') assert.match(details, /decompressed length/u);
            if (scenario === 'name mismatch') assert.match(details, /metadata mismatch/u);
            if (scenario === 'count mismatch') assert.match(details, /entry count mismatch/u);
            if (scenario === 'existing junction') assert.match(details, /not a regular directory/u);
            return true;
          });
        assert.equal(nativeCalls, 1);
        if (scenario === 'existing junction')
          assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
        if (scenario === 'existing output')
          assert.equal(
            fs.readFileSync(path.join(destination, 'runtime/тест.txt'), 'utf8'),
            'preserved'
          );
      });
    }
  );
}

test(
  'Windows inbox ZIP preserves long Unicode entry, archive, manifest and destination paths without global configuration',
  { skip: process.platform !== 'win32' },
  () => {
    fixture((root) => {
      const longRoot = path.join(
        root,
        ...Array.from({ length: 6 }, (_, index) => `${index}-long 'тест [x]-${'p'.repeat(45)}`)
      );
      fs.mkdirSync(longRoot, { recursive: true });
      const archive = path.join(longRoot, 'archive-тест.zip');
      const destination = path.join(longRoot, 'destination-тест');
      fs.mkdirSync(destination);
      const entry = `runtime/${Array.from({ length: 8 }, (_, index) => `${index}-${'s'.repeat(45)}`).join('/')}/тест.txt`;
      assert.ok(entry.length > 371 && archive.length > 260 && destination.length > 260);
      fs.writeFileSync(archive, zipFixture([{ name: entry, data: 'long Unicode fixture bytes' }]));
      extractWindowsRuntimeZip(
        archive,
        destination,
        assertSafeRuntimeZip(archive),
        process.env,
        (command, args, options) => execFileSync(command, args, { ...options, stdio: 'pipe' })
      );
      assert.equal(
        fs.readFileSync(path.join(destination, entry), 'utf8'),
        'long Unicode fixture bytes'
      );
      assert.deepEqual(fs.readdirSync(longRoot).sort(), ['archive-тест.zip', 'destination-тест']);
    });
  }
);

test('bootstrap extraction failure throws a bounded error and releases owned work and lock', async () => {
  const source = fs.readFileSync(new URL('../dev-with-runtime.mjs', import.meta.url), 'utf8');
  const functionSource = source.slice(
    source.indexOf('async function ensureBootstrappedRuntime()'),
    source.indexOf('function validateRuntimeRepoRoot(')
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-bootstrap-extract-failure-'));
  const cacheDir = path.join(root, 'fixture', 'fixture');
  let closed = false;
  const run = runInNewContext(`${functionSource}; ensureBootstrappedRuntime`, {
    fs,
    path,
    phase,
    process: { pid: process.pid },
    runtimeCacheRoot: root,
    readRuntimeLock: () => ({
      version: 'fixture',
      sourceRef: 'fixture',
      assets: {
        fixture: {
          binaryName: 'orchestrator',
          sha256: 'a'.repeat(64),
          archiveKind: 'zip',
          file: 'fixture.zip',
        },
      },
    }),
    getExpectedRuntimeCliVersion: () => 'fixture',
    getPlatformAssetKey: () => 'fixture',
    isRuntimePayloadCacheValid: async () => false,
    isCachedBinaryValid: () => false,
    acquireBootstrapLock: async () => {
      fs.writeFileSync(path.join(cacheDir, '.bootstrap.lock'), 'owned');
      return {
        close: async () => {
          closed = true;
        },
      };
    },
    getReleaseAssetDownload: () => ({}),
    downloadReleaseAssetWithGh: () => true,
    verifyRuntimeArchiveChecksum: async () => {},
    logRuntimePhase: () => {},
    extractArchive: (
      _archive: string,
      destination: string,
      _kind: string,
      runner: (command: string, args: string[]) => unknown
    ): void => {
      fs.mkdirSync(destination, { recursive: true });
      runner('TEST-native-reader', ['-EncodedCommand', 'static-source-must-not-leak'.repeat(100)]);
    },
    spawnSyncWithWindowsShell: () => ({ status: 7 }),
  }) as () => Promise<unknown>;
  try {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'message' in error);
      assert.equal(error.message, 'Runtime archive extraction failed (exit 7)');
      return true;
    });
    assert.equal(closed, true);
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
