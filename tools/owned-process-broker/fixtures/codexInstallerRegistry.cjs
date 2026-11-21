/* TEST-only exact registry responses for the stock installer inside the captured Electron Main. */
'use strict';
if (process.type === 'browser' && process.versions.electron) {
  const assert = require('node:assert/strict');
  const { createHash } = require('node:crypto');
  const { appendFileSync, lstatSync, readFileSync, realpathSync } = require('node:fs');
  const { basename, dirname, join } = require('node:path');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const fixturePath = process.env.TEST_CODEX_INSTALL_FIXTURE;
  assert.ok(fixturePath && fixturePath.startsWith('/'));
  assert.equal(realpathSync(fixturePath), fixturePath);
  assert.ok(lstatSync(fixturePath).isFile() && lstatSync(fixturePath).size < 65536);
  const bytes = readFileSync(fixturePath);
  assert.equal(sha(bytes), process.env.TEST_CODEX_INSTALL_FIXTURE_SHA256);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.kind, 'TEST-emulated-codex-installer-v1');
  assert.equal(fixture.root, dirname(fixturePath));
  assert.equal(basename(fixture.root), 'TEST-codex-install');
  assert.match(basename(dirname(fixture.root)), /^TEST-desktop-backend-[A-Za-z0-9]+$/u);
  assert.equal(realpathSync(fixture.root), fixture.root);
  assert.equal(realpathSync(__filename), fixture.preload.path);
  assert.equal(sha(readFileSync(__filename)), fixture.preload.sha256);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(fixture.tarball.path, join(fixture.root, 'TEST-codex-0.169.0-darwin-arm64.tgz'));
  const tarball = readFileSync(fixture.tarball.path);
  assert.ok(tarball.length > 0 && tarball.length < 256 * 1024);
  assert.equal(sha(tarball), fixture.tarball.sha256);
  assert.equal('sha512-' + createHash('sha512').update(tarball).digest('base64'), fixture.integrity);
  const log = join(fixture.root, 'registry.ndjson');
  let calls = 0, platforms = 0, downloads = 0;
  const effect = value => appendFileSync(log, JSON.stringify({ pid: process.pid, ...value }) + '\n', { mode: 0o600 });
  const original = globalThis.fetch;
  assert.equal(typeof original, 'function');
  effect({ event: 'armed', processType: process.type, electron: process.versions.electron, fixtureSha256: sha(bytes) });
  globalThis.fetch = async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const kind = url === fixture.latestUrl ? 'latest' : url === fixture.platformUrl ? 'platform' : url === fixture.tarballUrl ? 'tarball' : undefined;
    if (!kind) {
      const parsed = new URL(url);
      if (parsed.hostname === 'registry.npmjs.org' && /(?:@|%40)openai(?:\/|%2f)codex/i.test(parsed.pathname)) {
        effect({ event: 'failure', reason: 'unexpected-codex-registry-request' });
        throw new Error('TEST Codex registry refuses any other package request');
      }
      return original(input, options);
    }
    try {
      assert.ok(++calls <= 128);
      assert.equal(options?.method ?? (typeof input === 'object' && !(input instanceof URL) ? input.method : undefined) ?? 'GET', 'GET');
      assert.equal(options?.body, undefined);
      if (options?.signal?.aborted) throw options.signal.reason;
      if (kind === 'platform') assert.equal(++platforms, 1, 'one original platform acquisition');
      if (kind === 'tarball') assert.equal(++downloads, 1, 'one original package acquisition');
      const body = kind === 'tarball' ? tarball : JSON.stringify(kind === 'latest' ? fixture.latestMetadata : fixture.platformMetadata);
      effect({ event: 'response', kind, sequence: calls, sha256: sha(body), bytes: Buffer.byteLength(body) });
      return new Response(body, { status: 200, headers: { 'content-type': kind === 'tarball' ? 'application/octet-stream' : 'application/json',
        'content-length': String(Buffer.byteLength(body)) } });
    } catch (error) {
      effect({ event: 'failure', reason: 'finite-request-contract' }); throw error;
    }
  };
}
