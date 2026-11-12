import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileHash } from './native-host.ts';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** Follow the frozen Host dependency and its checked-in receipt, never a stale proof-only pin. */
export async function readNativeProviderArtifact(repo: string) {
  const manifest = object(JSON.parse(await readFile(join(repo, 'packages/legacy-agent-host/package.json'), 'utf8')));
  const dependency = object(manifest.dependencies)['@agent-teams/provider-implementations'];
  assert.ok(typeof dependency === 'string' &&
    /^file:\.\.\/\.\.\/vendor\/provider-migration\/[a-z0-9-]+\/agent-teams-provider-implementations-0\.0\.0\.tgz$/.test(dependency));
  const path = dependency.slice('file:../../'.length);
  const receipt = object(JSON.parse(await readFile(join(repo, dirname(path), 'source-receipt.json'), 'utf8')));
  const sha256 = object(object(receipt.packages)['provider-implementations']).newSha256;
  assert.ok(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256));
  return { path, sha256 };
}

/** Check both archive identity and the actual JavaScript the native Host will import. */
export async function verifyNativeProviderArtifact(
  repo: string,
  selected?: { path: string; sha256: string }
): Promise<void> {
  selected ??= await readNativeProviderArtifact(repo);
  const archive = join(repo, selected.path);
  assert.equal(await fileHash(archive), selected.sha256);
  const providerRoot = await realpath(
    join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations')
  );
  const entries = execFileSync('/usr/bin/tar', ['-tf', archive], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((path) => /^package\/dist\/.+\.js$/.test(path));
  assert.ok(entries.length > 0);
  for (const path of entries) {
    assert.ok(!path.includes('..'));
    assert.deepEqual(
      await readFile(join(providerRoot, path.slice('package/'.length))),
      execFileSync('/usr/bin/tar', ['-xOf', archive, path])
    );
  }
}
