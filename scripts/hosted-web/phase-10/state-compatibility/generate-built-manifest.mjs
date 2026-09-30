#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FORMAT = 'hosted-state-compatibility-manifest/v1';
const DEFAULT_OUTPUT = resolve('dist-standalone/state-compatibility/manifest.json');

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createBuiltStateManifest(artifactVersion) {
  return Object.freeze({
    artifactVersion,
    format: FORMAT,
    hostedStateSchemaVersion: 1,
    manifestId: `hosted-state-v1-artifact-${artifactVersion}`,
    minimumReadableHostedStateVersion: 1,
    orderedMigrations: Object.freeze([]),
    schemaVersion: 1,
  });
}

export function serializeBuiltStateManifest(manifest) {
  return `${stableJson(manifest)}\n`;
}

export async function generateBuiltStateManifest(outputPath = DEFAULT_OUTPUT) {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('built-state-manifest-artifact-version-invalid');
  }
  const body = serializeBuiltStateManifest(createBuiltStateManifest(packageJson.version));
  const digest = createHash('sha256').update(body).digest('hex');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeAtomic(outputPath, body);
  await writeAtomic(`${outputPath}.sha256`, `${digest}\n`);
  return Object.freeze({ manifest: outputPath, sha256: digest });
}

async function writeAtomic(path, body) {
  const staging = `${path}.${randomUUID()}.staging`;
  const handle = await open(staging, 'wx', 0o644);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.close();
    await rename(staging, path);
  } finally {
    await handle.close();
    await rm(staging, { force: true });
  }
}

function parseArguments(args) {
  if (args.length === 0) return DEFAULT_OUTPUT;
  if (args.length === 2 && args[0] === '--output' && args[1]) return resolve(args[1]);
  throw new Error('usage: generate-built-manifest.mjs [--output <path>]');
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await generateBuiltStateManifest(parseArguments(process.argv.slice(2)));
}
