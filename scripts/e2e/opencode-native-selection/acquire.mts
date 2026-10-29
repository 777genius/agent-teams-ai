import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { fetchOpenCodePackageMetadata } from '../../../src/main/services/infrastructure/openCodeRuntimePackageMetadata';

import { pins } from './pins.mts';

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export type Metadata = {
  name: string;
  version: string;
  optionalDependencies?: Record<string, string>;
  dist: { tarball: string; integrity: string };
};

export function pinned(name: string, version: string): Metadata {
  const all: Record<string, Metadata> = pins;
  const expected = all[`${name}@${version}`];
  assert(expected, 'Requested package has no reviewed immutable metadata pin');
  return expected;
}

export async function metadata(name: string, version: string): Promise<Metadata> {
  const expected = pinned(name, version);
  const actual = await fetchOpenCodePackageMetadata(name, version);
  assert.equal(actual.name, expected.name);
  assert.equal(actual.version, expected.version);
  assert.equal(actual.dist?.tarball, expected.dist.tarball);
  assert.equal(actual.dist?.integrity, expected.dist.integrity);
  // Compare only dependency contracts, never registry timestamps or signatures.
  assert.deepEqual(actual.optionalDependencies, expected.optionalDependencies);
  return expected;
}

export async function acquire(expected: Metadata): Promise<Buffer> {
  const url = new URL(expected.dist.tarball);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'registry.npmjs.org');
  assert.equal(url.username + url.password + url.search + url.hash, '');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  assert(response.ok && response.body, 'Pinned vendor package acquisition failed');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      assert(size <= 350 * 1024 * 1024, 'Vendor archive exceeds acquisition bound');
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    if (!response.body.locked) await response.body.cancel();
  }
  const bytes = Buffer.concat(chunks);
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(sri, expected.dist.integrity, 'Vendor package SRI mismatch');
  return bytes;
}
