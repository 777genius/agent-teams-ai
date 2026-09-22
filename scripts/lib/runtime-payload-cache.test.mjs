import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { verifyRuntimeArchiveChecksum } from './runtime-archive-checksum.mjs';
import {
  extractArchive, findExtractedBinary, isRuntimePayloadCacheValid, publishRuntimePayload,
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
          await assert.rejects(verifyRuntimeArchiveChecksum(archive, { sha256: '0'.repeat(64) }, 'fixture'));
          const extracted = path.join(root, 'extracted');
          extractArchive(archive, extracted, archiveKind, (cmd, args) => execFileSync(cmd, args));
          const binary = findExtractedBinary(extracted, 'orchestrator');
          const cache = path.join(root, 'cache with spaces');
          // Bare older cache cannot establish whether its archive had companions.
          fs.mkdirSync(cache);
          fs.copyFileSync(binary, path.join(cache, 'orchestrator'));
          assert.equal(isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), false);
          publishRuntimePayload(binary, cache, sha256);
          fs.rmSync(extracted, { recursive: true });
          assert.equal(isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), true);
          assert.equal(isRuntimePayloadCacheValid(cache, '0'.repeat(64), 'orchestrator'), false);
          assert.equal(fs.existsSync(path.join(cache, 'cursor-managed')), managed);
          if (managed) {
            fs.unlinkSync(path.join(cache, 'cursor-managed/plugin/index.js'));
            assert.equal(isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), false);
          } else {
            fs.writeFileSync(path.join(cache, 'orchestrator'), 'changed');
            assert.equal(isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), false);
          }
          extractArchive(archive, extracted, archiveKind, (cmd, args) => execFileSync(cmd, args));
          publishRuntimePayload(findExtractedBinary(extracted, 'orchestrator'), cache, sha256);
          assert.equal(isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), true);
          // A failed replacement leaves the previously complete payload available.
          fs.symlinkSync('missing', path.join(path.dirname(findExtractedBinary(extracted, 'orchestrator')), 'bad-link'));
          assert.throws(() => publishRuntimePayload(findExtractedBinary(extracted, 'orchestrator'), cache, sha256));
          assert.equal(isRuntimePayloadCacheValid(cache, sha256, 'orchestrator'), true);
          assert.equal(fs.readdirSync(root).some((name) => name.includes('.stage-')), false);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}


test('cached bootstrap waits for publication lock before validating or executing the binary', async () => {
  const source = fs.readFileSync(new URL('../dev-with-runtime.mjs', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('async function ensureBootstrappedRuntime()'),
    source.indexOf('function validateRuntimeRepoRoot('));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cache-reader-'));
  const events = [];
  let unlock;
  const publication = new Promise((resolve) => { unlock = resolve; });
  const run = runInNewContext(`${functionSource}; ensureBootstrappedRuntime`, {
    fs, path,
    runtimeCacheRoot: root,
    readRuntimeLock: () => ({ version: 'fixture', sourceRef: 'fixture',
      assets: { fixture: { binaryName: 'orchestrator', sha256: 'a'.repeat(64) } } }),
    getExpectedRuntimeCliVersion: () => 'fixture',
    getPlatformAssetKey: () => 'fixture',
    ensureDir: (directory) => fs.mkdirSync(directory, { recursive: true }),
    acquireBootstrapLock: async () => {
      events.push('waiting');
      await publication;
      events.push('locked');
      return { close: async () => { events.push('closed'); } };
    },
    isRuntimePayloadCacheValid: () => { events.push('validate'); return true; },
    isCachedBinaryValid: () => true,
    readBinaryVersion: () => { events.push('execute-version'); return 'fixture'; },
  });
  try {
    const result = run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['waiting']);
    unlock();
    const resolved = await result;
    assert.equal(resolved.downloaded, false);
    assert.equal(resolved.versionText, 'fixture');
    assert.deepEqual(events, ['waiting', 'locked', 'validate', 'execute-version', 'closed']);
  } finally {
    unlock();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
