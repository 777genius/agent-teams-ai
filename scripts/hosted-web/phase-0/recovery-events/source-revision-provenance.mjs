import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MUTATION_CENSUS_SOURCE_PATHS = [
  'scripts/hosted-web/phase-0/recovery-events/generate-evidence.mjs',
  'scripts/hosted-web/phase-0/recovery-events/mutation-census.mjs',
  'scripts/hosted-web/phase-0/recovery-events/source-revision-provenance.mjs',
  'docs/research/hosted-web/phase-0/recovery-events/mutation-surface-manifest.json',
  'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json',
];

export async function resolveMutationCensusSourceRevision({ root, sourceScopes }) {
  const sourcePaths = [
    ...MUTATION_CENSUS_SOURCE_PATHS,
    ...sourceScopes.map((scope) => scope.sourceFile),
  ];
  const uniqueSourcePaths = [...new Set(sourcePaths)];
  const git = (args) =>
    execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
  const { stdout: dirtySources } = await git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...uniqueSourcePaths,
  ]);
  if (dirtySources.trim()) {
    throw new Error(
      `Evidence source inputs must be committed before generation:\n${dirtySources.trim()}`
    );
  }

  const { stdout } = await git(['rev-list', '-1', 'HEAD', '--', ...uniqueSourcePaths]);
  const observedAtSha = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(observedAtSha)) {
    throw new Error('Evidence source revision could not be resolved');
  }
  await git(['diff', '--quiet', observedAtSha, 'HEAD', '--', ...uniqueSourcePaths]);
  return observedAtSha;
}
