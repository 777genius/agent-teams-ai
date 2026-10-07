import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  assertFullPackagedGate,
  classifyPackagedPr,
  isMetadataOnlyEdit,
  readPullRequest,
} from './packaged-ci-policy.mts';
import type { PackagedDecision } from './packaged-ci-policy.mts';

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Git evidence unavailable');
  return result.stdout;
}

export function collectPackagedDecision(env: NodeJS.ProcessEnv, cwd: string): PackagedDecision {
  try {
    const event: unknown = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    const eventName = env.GITHUB_EVENT_NAME ?? '';
    const input = readPullRequest(eventName, event);
    if (!input || isMetadataOnlyEdit(input)) return classifyPackagedPr(eventName, event);
    // Full SHAs only; verify objects locally, never trust a paginated GitHub file list.
    for (const sha of [input.baseSha, input.headSha]) {
      if (
        git(['rev-parse', '--verify', `${sha}^{commit}`], cwd)
          .trim()
          .toLowerCase() !== sha.toLowerCase()
      ) {
        throw new Error('Commit identity mismatch');
      }
    }
    const diff = git(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--raw',
        '--no-abbrev',
        '-z',
        '--find-renames',
        `${input.baseSha}...${input.headSha}`,
        '--',
      ],
      cwd
    );
    return classifyPackagedPr(eventName, event, diff);
  } catch {
    return { scope: 'full', run: true, reason: 'event/git evidence unavailable' };
  }
}

function main(): void {
  if (process.argv[2] === 'classify') {
    const result = collectPackagedDecision(process.env, process.cwd());
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `scope=${result.scope}\nrun=${result.run}\n`);
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (process.argv[2] === 'gate') {
    assertFullPackagedGate({
      scope: process.env.PACKAGED_SCOPE,
      scopeResult: process.env.SCOPE_RESULT,
      packagedResult: process.env.PACKAGED_RESULT,
    });
    console.log('Full packaged verification succeeded on all five platforms.');
    return;
  }
  throw new Error('Usage: node scripts/ci/packaged-ci-cli.mts classify|gate');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
