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
const runtimeSourceRepository = '777genius/agent_teams_orchestrator';
const publicRuntimeReleaseRepository = '777genius/agent_teams_orchestrator_binaries';

if (!version) {
  fail('version is required');
}

if (!sourceRef || sourceRef !== `v${version}`) {
  fail(`sourceRef must match version. Expected v${version}, got ${sourceRef || '<empty>'}`);
}

if (sourceRepository !== runtimeSourceRepository) {
  fail(
    `sourceRepository must point at the canonical runtime source repository (${runtimeSourceRepository}), got ${sourceRepository || '<empty>'}.`
  );
}

if (releaseRepository !== publicRuntimeReleaseRepository) {
  fail(
    `releaseRepository must point at the public runtime binary repository (${publicRuntimeReleaseRepository}), got ${releaseRepository || '<empty>'}.`
  );
}

if (releaseTag !== `runtime-${sourceRef}`) {
  fail(
    `releaseTag must point at the namespaced public runtime release tag (runtime-${sourceRef}), got ${releaseTag || '<empty>'}.`
  );
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

for (const [platform, asset] of Object.entries(lock.assets ?? {})) {
  const file = typeof asset.file === 'string' ? asset.file : '';
  if (!file.includes(`-v${version}.`)) {
    fail(`asset ${platform} file must include -v${version}: ${file || '<empty>'}`);
  }
  const sha256 = typeof asset.sha256 === 'string' ? asset.sha256.trim().toLowerCase() : '';
  if (!SHA256_PATTERN.test(sha256)) {
    fail(
      `asset ${platform} must pin a 64-hex sha256 of the published archive, got ${asset.sha256 ?? '<missing>'}.`
    );
  }
}

console.log('[verify-runtime-lock] OK');
