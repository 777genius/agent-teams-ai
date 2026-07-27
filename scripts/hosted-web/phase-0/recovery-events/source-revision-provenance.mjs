import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MUTATION_CENSUS_SOURCE_PATHS = [
  'scripts/hosted-web/phase-0/recovery-events/generate-evidence.mjs',
  'scripts/hosted-web/phase-0/recovery-events/mutation-census.mjs',
  'scripts/hosted-web/phase-0/recovery-events/source-revision-provenance.mjs',
  'docs/research/hosted-web/phase-0/recovery-events/mutation-surface-manifest.json',
  'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json',
];

export async function computeSourceSnapshotSha256({ root, sourcePaths }) {
  const hash = createHash('sha256');
  hash.update('mutation-census-source-snapshot-v1\0');
  for (const sourcePath of [...new Set(sourcePaths)].sort()) {
    const content = await readFile(resolve(root, sourcePath));
    const pathBytes = Buffer.from(sourcePath, 'utf8');
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return hash.digest('hex');
}

export async function resolveMutationCensusSourceSnapshotSha256({ root, sourceScopes }) {
  const sourcePaths = [
    ...MUTATION_CENSUS_SOURCE_PATHS,
    ...sourceScopes.map((scope) => scope.sourceFile),
  ];
  return computeSourceSnapshotSha256({ root, sourcePaths });
}
