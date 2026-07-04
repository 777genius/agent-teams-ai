#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const runtimeLockPath = path.join(repoRoot, 'runtime.lock.json');
const lock = JSON.parse(fs.readFileSync(runtimeLockPath, 'utf8'));

function fail(message) {
  console.error(`[verify-runtime-lock] ${message}`);
  process.exit(1);
}

if (!lock || typeof lock !== 'object') {
  fail('runtime.lock.json must contain an object');
}

const version = typeof lock.version === 'string' ? lock.version.trim() : '';
const sourceRef = typeof lock.sourceRef === 'string' ? lock.sourceRef.trim() : '';
const sourceRepository =
  typeof lock.sourceRepository === 'string' ? lock.sourceRepository.trim() : '';
const releaseRepository =
  typeof lock.releaseRepository === 'string' ? lock.releaseRepository.trim() : '';
const releaseTag = typeof lock.releaseTag === 'string' ? lock.releaseTag.trim() : '';

if (!version) {
  fail('version is required');
}

if (!sourceRef || sourceRef !== `v${version}`) {
  fail(`sourceRef must match version. Expected v${version}, got ${sourceRef || '<empty>'}`);
}

if (!sourceRepository) {
  fail('sourceRepository is required');
}

if (releaseRepository !== sourceRepository) {
  fail(
    `releaseRepository must point at the runtime source repository (${sourceRepository}), got ${releaseRepository || '<empty>'}.`
  );
}

if (releaseTag !== sourceRef) {
  fail(
    `releaseTag must point at the runtime release tag (${sourceRef}), got ${releaseTag || '<empty>'}.`
  );
}

for (const [platform, asset] of Object.entries(lock.assets ?? {})) {
  const file = typeof asset.file === 'string' ? asset.file : '';
  if (!file.includes(`-v${version}.`)) {
    fail(`asset ${platform} file must include -v${version}: ${file || '<empty>'}`);
  }
}

console.log('[verify-runtime-lock] OK');
