import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NO_PRIOR_COMMIT_REF = '0'.repeat(40);

const scriptPath = fileURLToPath(import.meta.url);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function assertCommitRef(value, label) {
  if (!SHA_PATTERN.test(value ?? '')) {
    throw new Error(`${label} must be a 40-character commit SHA`);
  }
  return value;
}

export function firstParentFromCommitObject(commitObject) {
  for (const line of commitObject.split(/\r?\n/)) {
    if (line === '') break;
    if (!line.startsWith('parent ')) continue;
    return assertCommitRef(line.slice('parent '.length), 'commit parent');
  }
  return null;
}

function runGit(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function resolveArchitectureBaselineRef({
  eventBaselineRef,
  git = runGit,
  headSha,
  root = process.cwd(),
}) {
  let baselineRef = assertCommitRef(eventBaselineRef, 'event architecture baseline ref');

  if (baselineRef === NO_PRIOR_COMMIT_REF) {
    const currentHead = assertCommitRef(headSha, 'GITHUB_SHA');
    const commitObject = git(['cat-file', 'commit', currentHead], root);
    baselineRef = firstParentFromCommitObject(commitObject) ?? NO_PRIOR_COMMIT_REF;
  }

  if (baselineRef !== NO_PRIOR_COMMIT_REF) {
    git(['fetch', '--no-tags', '--depth=1', 'origin', baselineRef], root);
    git(['cat-file', '-e', `${baselineRef}^{commit}`], root);
  }

  return baselineRef;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.stdout.write(
      `${resolveArchitectureBaselineRef({
        eventBaselineRef: process.env.ARCHITECTURE_EVENT_BASELINE_REF,
        headSha: process.env.GITHUB_SHA,
      })}\n`
    );
  } catch (error) {
    console.error(
      `[architecture-baseline] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
