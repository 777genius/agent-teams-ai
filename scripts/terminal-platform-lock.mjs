#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const lockPath = path.join(repoRoot, 'terminal-platform.lock.json');

function readLock() {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [command, arg] = process.argv.slice(2);
const lock = readLock();

switch (command) {
  case 'version':
    process.stdout.write(`${lock.version}\n`);
    break;
  case 'source-ref':
    process.stdout.write(`${lock.sourceRef}\n`);
    break;
  case 'source-repository':
    process.stdout.write(`${lock.sourceRepository}\n`);
    break;
  case 'release-repository':
    process.stdout.write(`${lock.releaseRepository}\n`);
    break;
  case 'release-tag':
    process.stdout.write(`${lock.releaseTag || lock.sourceRef}\n`);
    break;
  case 'asset-name': {
    const asset = lock.assets[arg];
    if (!asset) {
      fail(`Unknown terminal-platform asset platform: ${arg ?? '<missing>'}`);
    }
    process.stdout.write(`${asset.file}\n`);
    break;
  }
  case 'binary-name': {
    const asset = lock.assets[arg];
    if (!asset) {
      fail(`Unknown terminal-platform asset platform: ${arg ?? '<missing>'}`);
    }
    process.stdout.write(`${asset.binaryName}\n`);
    break;
  }
  case 'asset-list':
    for (const asset of Object.values(lock.assets)) {
      process.stdout.write(`${asset.file}\n`);
    }
    break;
  case 'release-file-list':
    for (const asset of Object.values(lock.assets)) {
      process.stdout.write(`${asset.file}\n`);
    }
    process.stdout.write(`terminal-platform-runtime-manifest-v${lock.version}.json\n`);
    process.stdout.write(`terminal-platform-runtime-SHA256SUMS-v${lock.version}\n`);
    break;
  default:
    fail(
      'Usage: node scripts/terminal-platform-lock.mjs <version|source-ref|source-repository|release-repository|release-tag|asset-name <platform>|binary-name <platform>|asset-list|release-file-list>'
    );
}
