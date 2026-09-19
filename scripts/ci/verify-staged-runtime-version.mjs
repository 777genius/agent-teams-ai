#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getExpectedRuntimeCliVersion,
  matchesRuntimeCliVersion,
} from '../lib/runtime-cli-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'runtime.lock.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const asset = lock.assets[platform];
if (!asset) throw new Error(`No runtime pin for ${platform}`);
const binary = path.join(root, 'resources/runtime', asset.binaryName);
const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
if (
  result.error ||
  result.status !== 0 ||
  !matchesRuntimeCliVersion(result.stdout, getExpectedRuntimeCliVersion(lock))
) {
  throw new Error(
    `Staged runtime version check failed for ${platform}: ${result.error?.message ?? result.status}`
  );
}
console.log(`Verified staged runtime ${lock.version} for ${platform}`);
