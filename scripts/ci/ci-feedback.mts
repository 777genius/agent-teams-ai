import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  object,
  provePostmergeReuse,
  REPOSITORY,
  rootTestShards,
  runnerImage,
  sha,
  WORKFLOW,
} from './ci-feedback-reuse.mts';
import type { GitHubRead } from './ci-feedback-reuse.mts';

export type Plan = {
  full: boolean;
  reuse: boolean;
  source_run: string;
  image: string;
  linux_arch: string;
  reason: string;
};

export function selectFeedbackMode(eventName: unknown, event: unknown): 'fast' | 'full' {
  try {
    if (eventName !== 'pull_request') return 'full';
    const payload = object(event);
    const pr = object(payload.pull_request);
    if (
      object(payload.repository).full_name !== REPOSITORY ||
      typeof pr.draft !== 'boolean' ||
      !Number.isSafeInteger(pr.number) ||
      Number(pr.number) <= 0 ||
      payload.number !== pr.number ||
      pr.state !== 'open'
    )
      return 'full';
    sha(object(pr.head).sha);
    sha(object(pr.base).sha);
    if (payload.action === 'edited') {
      const changes = object(payload.changes);
      const fields = Object.keys(changes);
      if (fields.length === 0 || fields.some((field) => field !== 'title' && field !== 'body')) {
        return 'full';
      }
      for (const field of fields) {
        const previous = object(changes[field]).from;
        if (typeof previous !== 'string' && !(field === 'body' && previous === null)) {
          return 'full';
        }
      }
      return pr.draft ? 'fast' : 'full';
    }
    if (
      typeof payload.action !== 'string' ||
      !['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft'].includes(
        payload.action
      )
    ) {
      return 'full';
    }
    if (payload.action === 'ready_for_review' && pr.draft) return 'full';
    if (payload.action === 'converted_to_draft' && !pr.draft) return 'full';
    // The accepted draft/intermediate contract includes synchronize and reopened:
    // every ready update runs full, and draft feedback never qualifies the merge gate.
    return pr.draft ? 'fast' : 'full';
  } catch {
    return 'full';
  }
}

export async function planFeedback(
  env: Record<string, string | undefined>,
  event: unknown,
  read: GitHubRead,
  now = Date.now()
): Promise<Plan> {
  const fallback: Plan = {
    full: true,
    reuse: false,
    source_run: '',
    image: runnerImage(env),
    linux_arch: ['X64', 'ARM64'].includes(env.RUNNER_ARCH ?? '') ? env.RUNNER_ARCH! : 'unknown',
    reason: 'Full qualification required',
  };
  if (env.GITHUB_REPOSITORY !== REPOSITORY) return fallback;
  try {
    sha(env.GITHUB_SHA);
    rootTestShards(env.CI_ROOT_TEST_SHARDS);
  } catch {
    return fallback;
  }
  if (selectFeedbackMode(env.GITHUB_EVENT_NAME, event) === 'fast') {
    return { ...fallback, full: false, reason: 'Draft feedback' };
  }
  if (env.GITHUB_EVENT_NAME !== 'push') return fallback;
  if (env.RUNNER_OS !== 'Linux') return fallback;
  if (
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main` ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA
  )
    return fallback;
  try {
    const payload = object(event);
    if (
      payload.ref !== 'refs/heads/main' ||
      payload.deleted !== false ||
      payload.after !== env.GITHUB_SHA ||
      object(payload.repository).full_name !== REPOSITORY
    )
      return fallback;
  } catch {
    return fallback;
  }
  const proof = await provePostmergeReuse(
    {
      repository: env.GITHUB_REPOSITORY,
      currentSha: env.GITHUB_SHA!,
      linuxRunner: env.CI_LINUX_RUNNER ?? '',
      linuxArch: env.RUNNER_ARCH ?? '',
      linuxImage: fallback.image,
      rootTestShards: env.CI_ROOT_TEST_SHARDS,
      now,
    },
    read
  );
  return { ...fallback, reuse: proof.reuse, source_run: proof.sourceRun, reason: proof.reason };
}

export async function windowsFeedback(
  env: Record<string, string | undefined>,
  read: GitHubRead,
  now = Date.now()
): Promise<{ reuse: boolean; image: string; reason: string }> {
  const fallback = {
    reuse: false,
    image: runnerImage(env),
    reason: 'Fresh Windows execution required',
  };
  if (env.MODE_REUSE !== 'true' || !/^[1-9]\d*$/.test(env.SOURCE_RUN ?? '')) return fallback;
  if (
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@refs/heads/main` ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.RUNNER_OS !== 'Windows' ||
    env.RUNNER_ARCH !== 'X64'
  )
    return fallback;
  const proof = await provePostmergeReuse(
    {
      repository: env.GITHUB_REPOSITORY,
      currentSha: env.GITHUB_SHA ?? '',
      linuxRunner: env.CI_LINUX_RUNNER ?? '',
      linuxArch: env.CI_LINUX_ARCH ?? '',
      linuxImage: env.CI_LINUX_IMAGE ?? '',
      rootTestShards: env.CI_ROOT_TEST_SHARDS,
      windowsImage: fallback.image,
      sourceRun: env.SOURCE_RUN,
      now,
    },
    read
  );
  return { ...fallback, reuse: proof.reuse, reason: proof.reason };
}

export function qualifyFull(
  results: unknown,
  full: unknown,
  reuse: unknown,
  shardCount?: unknown
): { ok: boolean; reason: string } {
  try {
    rootTestShards(shardCount);
    if (full !== 'true') throw new Error('Draft feedback does not qualify for merge');
    if (reuse !== 'true' && reuse !== 'false') throw new Error('Invalid reuse mode');
    const needs = object(results);
    const plan = object(needs.plan);
    const outputs = object(plan.outputs);
    if (plan.result !== 'success' || outputs.full !== full || outputs.reuse !== reuse) {
      throw new Error('Plan did not successfully bind gate mode');
    }
    if (
      reuse === 'true' &&
      (typeof outputs.source_run !== 'string' || !/^[1-9]\d*$/.test(outputs.source_run))
    ) {
      throw new Error('Reuse lacks authenticated source run');
    }
    for (const name of ['validate', 'test', 'lint', 'task-change-ledger-windows']) {
      // GitHub's matrix job result aggregates every configured test shard.
      const result = object(needs[name]).result;
      if (
        result !== 'success' &&
        !(reuse === 'true' && (name === 'test' || name === 'lint') && result === 'skipped')
      ) {
        throw new Error(`Required job did not qualify: ${name}`);
      }
    }
    return {
      ok: true,
      reason:
        reuse === 'true'
          ? `Verified reuse from run ${outputs.source_run}`
          : 'Complete full qualification',
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Invalid gate inputs' };
  }
}

function ghRead(endpoint: string): unknown {
  // gh authenticates through the supplied Actions token. Force github.com, JSON and read-only GET.
  try {
    return JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--hostname',
          'github.com',
          '--method',
          'GET',
          '-H',
          'Accept: application/vnd.github+json',
          '-H',
          'X-GitHub-Api-Version: 2022-11-28',
          endpoint,
        ],
        {
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      ) as string
    );
  } catch {
    throw new Error('Authenticated GitHub API read failed');
  }
}

async function main(): Promise<void> {
  const read: GitHubRead = async (endpoint) => {
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)
      throw new Error('Missing authenticated API token');
    return ghRead(endpoint);
  };
  const output = (value: string): void => {
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GITHUB_OUTPUT');
    appendFileSync(process.env.GITHUB_OUTPUT, value);
  };
  if (process.argv[2] === 'image') {
    output(`image=${runnerImage(process.env)}\n`);
    return;
  }
  if (process.argv[2] === 'windows') {
    const windows = await windowsFeedback(process.env, read);
    output(`reuse=${windows.reuse}\nimage=${windows.image}\n`);
    console.log(windows.reason);
    return;
  }
  if (process.argv[2] === 'gate') {
    let results: unknown;
    try {
      results = JSON.parse(process.env.JOB_RESULTS ?? 'null');
    } catch {
      results = null;
    }
    const gate = qualifyFull(
      results,
      process.env.MODE_FULL,
      process.env.MODE_REUSE,
      process.env.CI_ROOT_TEST_SHARDS
    );
    console.log(gate.reason);
    if (!gate.ok) process.exitCode = 1;
    return;
  }
  if (process.argv[2] !== 'plan') throw new Error('Expected plan, gate, image or windows');
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch {
    event = null;
  }
  const plan = await planFeedback(process.env, event, read);
  output(
    `full=${plan.full}\nreuse=${plan.reuse}\nsource_run=${plan.source_run}\nimage=${plan.image}\nlinux_arch=${plan.linux_arch}\n`
  );
  console.log(plan.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
