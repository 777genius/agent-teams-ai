/** Linux CI only: exact npm installation per TEST case; never touches an existing user runtime. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { verifyNativeV1VersionReceipt } from './opencode-v1-version-receipt.ts';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.21.0');
const repo = resolve(import.meta.dirname, '../../..');
const sourceHead = process.env.OPENCODE_V1_TEST_SOURCE_HEAD ?? '';
assert.match(sourceHead, /^[a-f0-9]{40}$/);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo, encoding: 'utf8', timeout: 5000,
}).trim(), sourceHead);
const evidence = join(repo, 'opencode-v1-version-evidence');
await mkdir(evidence);

/** Bound trusted-registry metadata before parsing; resolve each tag exactly once. */
async function metadata(name: string, selector: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${selector}`, {
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, 'official npm metadata must be available');
  assert.ok(response.body);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= 2 * 1024 * 1024, 'finite metadata budget');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

for (const selector of ['1.19.4', '1.19.5', 'latest']) {
  const selected = await metadata('opencode-ai', selector);
  assert.equal(selected.name, 'opencode-ai');
  assert.equal(typeof selected.version, 'string');
  const version = selected.version as string;
  assert.match(version, /^1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.ok(Number.isSafeInteger(Number(version.split('.')[1])) && Number(version.split('.')[1]) >= 16);
  if (selector !== 'latest') assert.equal(version, selector);
  const dist = selected.dist as Record<string, unknown>;
  assert.equal(typeof dist.integrity, 'string');
  assert.match(dist.integrity as string, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const prefix = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-v1-')));
  for (const part of ['home', 'tmp', 'npm-cache']) await mkdir(join(prefix, part));
  const npmrc = join(prefix, 'user.npmrc');
  const globalNpmrc = join(prefix, 'global.npmrc');
  await writeFile(npmrc, '', { mode: 0o600 });
  await writeFile(globalNpmrc, '', { mode: 0o600 });
  await writeFile(join(prefix, 'package.json'), '{"name":"test-native-opencode-v1","private":true}\n');
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(prefix, 'home'), TMPDIR: join(prefix, 'tmp'),
    CI: 'true', NO_COLOR: '1', npm_config_registry: 'https://registry.npmjs.org',
    npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc,
    npm_config_cache: join(prefix, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
  };
  execFileSync('npm', ['install', '--prefix', prefix, '--save-exact', '--package-lock=true',
    '--ignore-scripts', '--no-audit', '--no-fund', `opencode-ai@${version}`], {
    cwd: prefix, env: environment, timeout: 120_000, stdio: 'inherit',
  });
  const lock = JSON.parse(await readFile(join(prefix, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/opencode-ai'].version, version);
  assert.equal(lock.packages['node_modules/opencode-ai'].integrity, dist.integrity,
    'moving registry metadata must not replace the exact selected root bytes');
  const receiptPath = join(evidence, `native-v1-${selector}.json`);
  execFileSync(process.execPath, ['--test', join(import.meta.dirname, 'opencode-v1-version-host.native.ts')], {
    cwd: repo, timeout: 240_000, stdio: 'inherit', env: {
      ...environment, OPENCODE_V1_VERSION_HOST_GO: '1', OPENCODE_V1_TEST_SOURCE_HEAD: sourceHead,
      OPENCODE_V1_TEST_EXPECTED_VERSION: version, OPENCODE_V1_TEST_PACKAGE_PREFIX: prefix,
      OPENCODE_V1_TEST_RECEIPT: receiptPath,
    },
  });
  verifyNativeV1VersionReceipt(JSON.parse(await readFile(receiptPath, 'utf8')), sourceHead, version);
  console.log(`TEST V1 ${selector} resolved once to ${version}: native Host receipt verified`);
}
