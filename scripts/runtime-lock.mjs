#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const runtimeLockPath = path.join(repoRoot, 'runtime.lock.json');

function readRuntimeLock() {
  return JSON.parse(fs.readFileSync(runtimeLockPath, 'utf8'));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [command, arg] = process.argv.slice(2);
const runtimeLock = readRuntimeLock();

switch (command) {
  case 'version':
    process.stdout.write(`${runtimeLock.version}\n`);
    break;
  case 'source-ref':
    process.stdout.write(`${runtimeLock.sourceRef}\n`);
    break;
  case 'source-repository':
    process.stdout.write(`${runtimeLock.sourceRepository}\n`);
    break;
  case 'release-repository':
    process.stdout.write(`${runtimeLock.releaseRepository}\n`);
    break;
  case 'release-tag':
    process.stdout.write(`${runtimeLock.releaseTag || runtimeLock.sourceRef}\n`);
    break;
  case 'asset-name': {
    const asset = runtimeLock.assets[arg];
    if (!asset) {
      fail(`Unknown runtime asset platform: ${arg ?? '<missing>'}`);
    }
    process.stdout.write(`${asset.file}\n`);
    break;
  }
  case 'binary-name': {
    const asset = runtimeLock.assets[arg];
    if (!asset) {
      fail(`Unknown runtime asset platform: ${arg ?? '<missing>'}`);
    }
    process.stdout.write(`${asset.binaryName}\n`);
    break;
  }
  case 'asset-list':
    for (const asset of Object.values(runtimeLock.assets)) {
      process.stdout.write(`${asset.file}\n`);
    }
    break;
  default:
    fail(
      'Usage: node scripts/runtime-lock.mjs <version|source-ref|source-repository|release-repository|release-tag|asset-name <platform>|binary-name <platform>|asset-list>'
    );
}
