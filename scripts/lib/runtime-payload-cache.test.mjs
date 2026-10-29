import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { constants, runInNewContext } from 'node:vm';

import { verifyRuntimeArchiveChecksum } from './runtime-archive-checksum.mjs';
import { phase } from './runtime-bootstrap-diagnostics.mts';
import { extractWindowsRuntimeZip } from './runtime-windows-zip-extraction.mts';
import { assertSafeRuntimeZip } from './runtime-archive-extraction.mts';
import {
  ambiguousDirectoryFixture,
  xlLinkFixture,
  zipFixture,
} from './runtime-zip.test-fixture.mts';
import {
  extractArchive,
  findExtractedBinary,
  isRuntimePayloadCacheValid,
  publishRuntimePayload,
} from './runtime-payload-cache.mjs';

// Fixture bytes deliberately aren't executable. Only archive utilities run.
for (const archiveKind of ['tar.gz']) {
  for (const layout of ['runtime', '.']) {
    for (const managed of [true, false]) {
      test(`${archiveKind} ${layout}: ${managed ? 'Cursor companions' : 'legacy binary'}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-payload-cache-'));
        try {
          const source = path.join(root, 'source');
          const payload = path.join(source, layout);
          fs.mkdirSync(payload, { recursive: true });
          fs.writeFileSync(path.join(payload, 'orchestrator'), 'fixture binary; never execute');
          if (managed) {
            for (const relative of ['manifest.json', 'plugin/index.js', 'mcp-tool/index.js']) {
              const file = path.join(payload, 'cursor-managed', relative);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, `fixture ${relative}`);
            }
          }
          const archive = path.join(root, `fixture.${archiveKind}`);
          execFileSync('tar', ['-czf', archive, '-C', source, '.']);
          const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
          await verifyRuntimeArchiveChecksum(archive, { sha256 }, 'fixture');
          await assert.rejects(
            verifyRuntimeArchiveChecksum(archive, { sha256: '0'.repeat(64) }, 'fixture')
          );
          const extracted = path.join(root, 'extracted');
          extractArchive(archive, extracted, archiveKind, (cmd, args) => execFileSync(cmd, args));
          const binary = findExtractedBinary(extracted, 'orchestrator');
          const cache = path.join(root, 'cache with spaces');
          // Bare older cache cannot establish whether its archive had companions.
          fs.mkdirSync(cache);
          fs.copyFileSync(binary, path.join(cache, 'orchestrator'));
          assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), false);
          await publishRuntimePayload(binary, cache, sha256);
          fs.rmSync(extracted, { recursive: true });
          assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), true);
          assert.equal(
            await isRuntimePayloadCacheValid(cache, '0'.repeat(64), 'orchestrator'),
            false
          );
          assert.equal(fs.existsSync(path.join(cache, 'cursor-managed')), managed);
          if (managed) {
            fs.unlinkSync(path.join(cache, 'cursor-managed/plugin/index.js'));
            assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), false);
          } else {
            fs.writeFileSync(path.join(cache, 'orchestrator'), 'changed');
            assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), false);
          }
          extractArchive(archive, extracted, archiveKind, (cmd, args) => execFileSync(cmd, args));
          await publishRuntimePayload(
            findExtractedBinary(extracted, 'orchestrator'),
            cache,
            sha256
          );
          assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), true);
          // A failed replacement leaves the previously complete payload available.
          fs.symlinkSync(
            'missing',
            path.join(path.dirname(findExtractedBinary(extracted, 'orchestrator')), 'bad-link')
          );
          await assert.rejects(() =>
            publishRuntimePayload(findExtractedBinary(extracted, 'orchestrator'), cache, sha256)
          );
          assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), true);
          assert.equal(
            fs.readdirSync(root).some((name) => name.includes('.stage-')),
            false
          );
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

test('ZIP extraction preserves Unicode and spaced companions through cache publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime ZIP тест with spaces-'));
  try {
    const source = path.join(root, 'source payload');
    const payload = path.join(source, 'runtime');
    const companion = 'cursor-managed/plugin/тест with spaces.js';
    const contents = Buffer.from('fixture companion bytes: тест\n');
    fs.mkdirSync(path.dirname(path.join(payload, companion)), { recursive: true });
    fs.writeFileSync(path.join(payload, 'orchestrator.exe'), 'fixture binary; never execute');
    fs.writeFileSync(path.join(payload, companion), contents);
    fs.writeFileSync(path.join(payload, 'cursor-managed/manifest.json'), '{"fixture":true}');

    const archive = path.join(root, 'runtime архив with spaces.zip');
    if (process.platform === 'win32') {
      const inboxTar = path.win32.join(process.env.SystemRoot, 'System32', 'tar.exe');
      process.stdout.write(
        `[Windows Unicode ZIP reader] ${execFileSync(inboxTar, ['--version'], { encoding: 'utf8' }).trim()}\n`
      );
      // Preserve the real PowerShell producer and Unicode native-reader regression.
      // libarchive#3063 documents UTF-8 pathname conversion failures in some inbox versions.
      // PowerShell preserves Unicode archive paths and UTF-8 ZIP entry names.
      const command = `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath '${payload.replace(/'/g, "''")}' -DestinationPath '${archive.replace(/'/g, "''")}' -Force`;
      execFileSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
      ]);
    } else {
      execFileSync('zip', ['-qr', archive, '.'], { cwd: source });
    }
    const archiveBytes = fs.readFileSync(archive);
    if (process.platform === 'win32') {
      const end = archiveBytes.lastIndexOf(Buffer.from('504b0506', 'hex'));
      assert.ok(end >= 0, 'fixture has an end-of-central-directory record');
      let cursor = archiveBytes.readUInt32LE(end + 16);
      const entries = [];
      for (let index = 0; index < archiveBytes.readUInt16LE(end + 10); index++) {
        assert.equal(archiveBytes.readUInt32LE(cursor), 0x02014b50);
        const length = archiveBytes.readUInt16LE(cursor + 28);
        const name = archiveBytes.subarray(cursor + 46, cursor + 46 + length);
        const local = archiveBytes.readUInt32LE(cursor + 42);
        entries.push({
          name: name.toString('utf8'),
          nameHex: name.toString('hex'),
          flags: archiveBytes.readUInt16LE(cursor + 8),
          localFlags: archiveBytes.readUInt16LE(local + 6),
        });
        cursor +=
          46 +
          length +
          archiveBytes.readUInt16LE(cursor + 30) +
          archiveBytes.readUInt16LE(cursor + 32);
      }
      process.stdout.write(`[Windows Unicode ZIP metadata] ${JSON.stringify(entries)}\n`);
      const unicode = entries.find((entry) => entry.name.replaceAll('\\', '/').endsWith(companion));
      assert.ok(unicode, 'fixture preserves the exact Unicode companion name in UTF-8');
      assert.equal(unicode.flags & 0x0800, 0x0800, 'central name declares UTF-8');
      assert.equal(unicode.localFlags & 0x0800, 0x0800, 'local name declares UTF-8');
    }
    const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
    await verifyRuntimeArchiveChecksum(archive, { sha256 }, 'fixture');
    await assert.rejects(
      verifyRuntimeArchiveChecksum(archive, { sha256: '0'.repeat(64) }, 'fixture')
    );

    const extracted = path.join(root, 'extracted тест with spaces');
    extractArchive(archive, extracted, 'zip', (cmd, args, options) =>
      execFileSync(cmd, args, options)
    );
    const binary = findExtractedBinary(extracted, 'orchestrator.exe');
    assert.equal(fs.readFileSync(binary, 'utf8'), 'fixture binary; never execute');
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(binary), companion)), contents);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(binary), 'cursor-managed/manifest.json'), 'utf8'),
      '{"fixture":true}'
    );

    const cache = path.join(root, 'cached тест with spaces');
    await publishRuntimePayload(binary, cache, sha256);
    fs.rmSync(extracted, { recursive: true, force: true });
    assert.deepEqual(fs.readFileSync(path.join(cache, companion)), contents);
    assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator.exe'), true);
    assert.equal(
      await isRuntimePayloadCacheValid(cache, '0'.repeat(64), 'orchestrator.exe'),
      false
    );
    fs.appendFileSync(path.join(cache, companion), 'tampered');
    assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator.exe'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cached bootstrap waits for publication lock before validating or executing the binary', async () => {
  const source = fs.readFileSync(new URL('../dev-with-runtime.mjs', import.meta.url), 'utf8');
  const functionSource = source.slice(
    source.indexOf('async function ensureBootstrappedRuntime()'),
    source.indexOf('function validateRuntimeRepoRoot(')
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cache-reader-'));
  const events = [];
  let unlock;
  const publication = new Promise((resolve) => {
    unlock = resolve;
  });
  let finishValidation;
  const validation = new Promise((resolve) => {
    finishValidation = resolve;
  });
  const run = runInNewContext(`${functionSource}; ensureBootstrappedRuntime`, {
    fs,
    path,
    phase,
    logRuntimePhase: () => {},
    runtimeCacheRoot: root,
    readRuntimeLock: () => ({
      version: 'fixture',
      sourceRef: 'fixture',
      assets: { fixture: { binaryName: 'orchestrator', sha256: 'a'.repeat(64) } },
    }),
    getExpectedRuntimeCliVersion: () => 'fixture',
    getPlatformAssetKey: () => 'fixture',
    ensureDir: (directory) => fs.mkdirSync(directory, { recursive: true }),
    acquireBootstrapLock: async () => {
      events.push('waiting');
      await publication;
      events.push('locked');
      return {
        close: async () => {
          events.push('closed');
        },
      };
    },
    isRuntimePayloadCacheValid: async () => {
      events.push('validate');
      await validation;
      return true;
    },
    isCachedBinaryValid: () => true,
    readBinaryVersion: () => {
      events.push('execute-version');
      return 'fixture';
    },
  });
  try {
    const result = run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['waiting']);
    unlock();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['waiting', 'locked', 'validate']);
    finishValidation();
    const resolved = await result;
    assert.equal(resolved.downloaded, false);
    assert.equal(resolved.versionText, 'fixture');
    assert.deepEqual(events, ['waiting', 'locked', 'validate', 'execute-version', 'closed']);
  } finally {
    unlock();
    finishValidation();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function windowsExtractor() {
  const source = fs.readFileSync(new URL('./runtime-payload-cache.mjs', import.meta.url), 'utf8');
  const functions = source
    .slice(source.indexOf('function assertRegularArchiveEntries('))
    .replace('export function extractArchive', 'function extractArchive');
  return runInNewContext(`${functions}; extractArchive`, {
    fs,
    path,
    assertSafeRuntimeZip,
    extractWindowsRuntimeZip,
    process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
  });
}

for (const caller of ['bootstrap', 'stager']) {
  test(`${caller}: Windows ZIP uses absolute inbox .NET reader, literal paths, and rejects symlinks`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-zip-contract-'));
    const archive = path.join(root, "archive [x] 'quote'.zip");
    const destination = path.join(root, "extracted [x] 'quote'");
    fs.writeFileSync(archive, zipFixture([{ name: 'runtime/file', data: 'fixture' }]));
    const shared = windowsExtractor();
    const extract =
      caller === 'bootstrap'
        ? shared
        : runInNewContext(
            `${fs
              .readFileSync(new URL('../stage-runtime.mjs', import.meta.url), 'utf8')
              .split('function extractArchive(')[1]
              .split('function findRuntimePayloadDir(')[0]
              .replace(/^/, 'function extractArchive(')}; extractArchive`,
            {
              fs,
              path,
              process: { platform: 'win32' },
              extractRuntimeArchive: shared,
              runOrThrow: (...args) => runner(...args),
            }
          );
    let runner;
    try {
      runner = (command, args, options) => {
        assert.equal(
          command,
          path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        );
        assert.equal(args[0], '-NoLogo');
        assert.equal(args[3], '-EncodedCommand');
        assert.equal(options.env.AGENT_TEAMS_RUNTIME_ZIP_ARCHIVE, archive);
        assert.equal(options.env.AGENT_TEAMS_RUNTIME_ZIP_DESTINATION, destination);
        assert.ok(fs.existsSync(options.env.AGENT_TEAMS_RUNTIME_ZIP_MANIFEST));
        assert.equal(options.shell, false);
        fs.mkdirSync(path.join(destination, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'nested', 'companion'), 'unchanged');
      };
      extract(archive, destination, 'zip', runner);
      assert.equal(
        fs.readFileSync(path.join(destination, 'nested/companion'), 'utf8'),
        'unchanged'
      );
      const error = new Error('extract fixture original error');
      runner = () => {
        throw error;
      };
      assert.throws(
        () => extract(archive, destination, 'zip', runner),
        (actual) => actual === error
      );
      runner = () => {
        const target = path.join(root, 'outside-dir');
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(destination, 'link'), 'junction');
      };
      assert.throws(
        () => extract(archive, destination, 'zip', runner),
        /Unsupported runtime archive entry/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test(
  'Windows inbox ZIP preserves actual nested ZIP payload under quoted paths',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-zip [x] 'quote'-"));
    try {
      const archive = path.join(root, "fixture [x] 'quote'.zip");
      const extracted = path.join(root, 'extracted');
      fs.writeFileSync(
        archive,
        zipFixture([
          { name: 'runtime/orchestrator', data: 'fixture binary; never execute' },
          { name: 'runtime/VERSION', data: 'fixture' },
          {
            name: "runtime/local-cli/nested/file [brackets] 'quote'.js",
            data: 'fixture companion',
          },
        ])
      );
      const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      await verifyRuntimeArchiveChecksum(archive, { sha256 }, 'native ZIP fixture');
      extractArchive(archive, extracted, 'zip', (command, args, options) =>
        execFileSync(command, args, options)
      );
      const cache = path.join(root, 'published');
      await publishRuntimePayload(findExtractedBinary(extracted, 'orchestrator'), cache, sha256);
      assert.equal(await isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), true);
      assert.equal(
        fs.readFileSync(
          path.join(extracted, "runtime/local-cli/nested/file [brackets] 'quote'.js"),
          'utf8'
        ),
        'fixture companion'
      );
      assert.equal(fs.readFileSync(path.join(extracted, 'runtime/VERSION'), 'utf8'), 'fixture');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('stager extraction failure preserves previous payload and removes only its owned work directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-stage-extract-failure-'));
  const downloadRoot = path.join(root, 'downloads');
  const runtimeDir = path.join(root, 'runtime');
  const error = new Error('native extraction fixture failure');
  fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(runtimeDir, 'previous'), 'preserved');
  const bytes = Buffer.from('fixture archive');
  const asset = {
    file: 'fixture.zip',
    binaryName: 'orchestrator',
    archiveKind: 'zip',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  let checksumVerified = false;
  const source = fs.readFileSync(new URL('../stage-runtime.mjs', import.meta.url), 'utf8');
  const run = runInNewContext(
    `${source.slice(source.indexOf('async function stageRuntime('), source.indexOf('async function main('))}; stageRuntime`,
    {
      fs,
      path,
      downloadRoot,
      process: { pid: process.pid, stdout: { write() {} } },
      readRuntimeLock: () => ({ version: 'fixture', assets: { 'win32-x64': asset } }),
      getReleaseTag: () => 'fixture',
      getReleaseAssetUrl: () => 'https://fixture.invalid/offline',
      downloadReleaseAssetWithGh: (_lock, _tag, _asset, archive) => {
        fs.writeFileSync(archive, bytes);
        return true;
      },
      verifyRuntimeArchiveChecksum: async (...args) => {
        await verifyRuntimeArchiveChecksum(...args);
        checksumVerified = true;
      },
      extractArchive: () => {
        assert(checksumVerified);
        throw error;
      },
      cleanRuntimeDir: () =>
        assert.fail('Failed extraction must not publish or clean previous payload'),
    },
    {
      // Keep the stager's early delivery-map guard on its real module loader.
      filename: fileURLToPath(new URL('../stage-runtime.mjs', import.meta.url)),
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }
  );
  try {
    await assert.rejects(run({ platform: 'win32-x64' }), (actual) => actual === error);
    assert.equal(fs.readFileSync(path.join(runtimeDir, 'previous'), 'utf8'), 'preserved');
    assert.deepEqual(fs.readdirSync(downloadRoot), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'Windows inbox ZIP inputs are rejected by preflight before extractor invocation',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-zip-safety [x] 'quote'-"));
    const outside = path.join(root, 'outside');
    const sentinel = path.join(outside, 'sentinel');
    const sentinelBytes = Buffer.from('existing owned outside data');
    fs.mkdirSync(outside);
    fs.writeFileSync(sentinel, sentinelBytes);
    const archives = [
      ['malformed', Buffer.from('not a ZIP archive')],
      ['comment-directory', ambiguousDirectoryFixture('comment')],
      ['locator-directory', ambiguousDirectoryFixture('locator')],
      ['xl-link', xlLinkFixture()],
      ['parent', zipFixture([{ name: '../outside/escape', data: 'outside write forbidden' }])],
      [
        'absolute',
        zipFixture([
          {
            name: path.join(outside, 'escape').replaceAll('\\', '/'),
            data: 'outside write forbidden',
          },
        ]),
      ],
      [
        'link',
        zipFixture([
          { name: 'link', data: '../outside', symlink: true },
          { name: 'link/escape', data: 'outside write forbidden' },
        ]),
      ],
    ];
    try {
      for (const [name, bytes] of archives) {
        const archive = path.join(root, `${name}.zip`);
        const extracted = path.join(root, `extracted-${name}`);
        fs.writeFileSync(archive, bytes);
        let rejected = false;
        let nativeCalls = 0;
        try {
          extractArchive(archive, extracted, 'zip', (command, args, options) => {
            nativeCalls++;
            return execFileSync(command, args, options);
          });
        } catch (error) {
          assert(error instanceof Error);
          rejected = true;
        }
        assert(rejected, `${name} archive must be rejected`);
        assert.equal(nativeCalls, 0, `${name} must not reach the native extractor`);
        assert.deepEqual(
          fs.readdirSync(outside),
          ['sentinel'],
          `${name} wrote outside extraction root`
        );
        assert.deepEqual(fs.readFileSync(sentinel), sentinelBytes);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
