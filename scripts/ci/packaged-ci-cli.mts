import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  assertFullPackagedGate,
  classifyPackagedPr,
  classifyCanonicalPackagedSnapshot,
  isMetadataOnlyEdit,
  readPullRequest,
} from './packaged-ci-policy.mts';
import type { PackagedDecision } from './packaged-ci-policy.mts';
import { collectChangeScope } from './ci-change-scope.mts';

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Git evidence unavailable');
  return result.stdout;
}

export function collectPackagedDecision(env: NodeJS.ProcessEnv, cwd: string): PackagedDecision {
  // Push admission must fail closed outside the PR fallback-to-FULL path.
  if (env.GITHUB_EVENT_NAME === 'push') {
    const event: unknown = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    const localHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], cwd).trim();
    return classifyCanonicalPackagedSnapshot(env, event, localHead);
  }
  try {
    const event: unknown = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    const eventName = env.GITHUB_EVENT_NAME ?? '';
    const input = readPullRequest(eventName, event);
    if (!input || isMetadataOnlyEdit(input)) return classifyPackagedPr(eventName, event);
    if (!input.draft && !input.labels.includes('ci:full')) {
      const decision = collectChangeScope(env, cwd);
      if (decision.scope !== 'full') {
        return { scope: decision.scope, run: false, reason: decision.reason };
      }
    }
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
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `scope=${result.scope}\nrun=${result.run}\ncanonical_snapshot=${result.canonicalSnapshot === true}\n`
      );
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (process.argv[2] === 'gate') {
    assertFullPackagedGate({
      scope: process.env.PACKAGED_SCOPE,
      scopeResult: process.env.SCOPE_RESULT,
      packagedResult: process.env.PACKAGED_RESULT,
      run: process.env.PACKAGED_RUN,
    });
    console.log(
      'Selected packaged verification passed; focused scopes are verified by CI qualification.'
    );
    return;
  }
  throw new Error('Usage: node scripts/ci/packaged-ci-cli.mts classify|gate');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
