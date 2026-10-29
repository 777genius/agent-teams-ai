import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
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
import {
  collectChangeScope,
  type ChangeClassification,
  type ChangeScope,
} from './ci-change-scope.mts';
import { proveMetadataProducer } from './ci-feedback-metadata-proof.mts';

export type Plan = {
  scope?: ChangeScope;
  full: boolean;
  metadata: boolean;
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

/** Only proven title/body edits may preserve existing current-code checks. */
export function isMetadataOnlyPrEdit(eventName: unknown, event: unknown): boolean {
  try {
    if (eventName !== 'pull_request') return false;
    const payload = object(event);
    const pr = object(payload.pull_request);
    const repository = object(payload.repository);
    const head = object(pr.head);
    const base = object(pr.base);
    const headRepo = object(head.repo);
    const baseRepo = object(base.repo);
    const positive = (value: unknown): boolean =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    const title = (value: unknown): boolean =>
      typeof value === 'string' && value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value);
    if (
      payload.action !== 'edited' ||
      repository.full_name !== REPOSITORY ||
      !positive(repository.id) ||
      !positive(pr.id) ||
      !positive(pr.number) ||
      payload.number !== pr.number ||
      pr.state !== 'open' ||
      typeof pr.draft !== 'boolean' ||
      !title(pr.title) ||
      (typeof pr.body !== 'string' && pr.body !== null) ||
      baseRepo.id !== repository.id ||
      baseRepo.full_name !== REPOSITORY ||
      !positive(headRepo.id) ||
      typeof headRepo.full_name !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(headRepo.full_name) ||
      (headRepo.id === repository.id) !== (headRepo.full_name === REPOSITORY) ||
      typeof head.ref !== 'string' ||
      head.ref.length === 0 ||
      typeof base.ref !== 'string' ||
      base.ref.length === 0
    )
      return false;
    sha(head.sha);
    sha(base.sha);
    const changes = object(payload.changes);
    const fields = Object.keys(changes);
    return (
      fields.length > 0 &&
      fields.every((field) => {
        if (field !== 'title' && field !== 'body') return false;
        const change = object(changes[field]);
        if (Object.keys(change).length !== 1 || !Object.hasOwn(change, 'from')) return false;
        return field === 'title'
          ? title(change.from)
          : typeof change.from === 'string' || change.from === null;
      })
    );
  } catch {
    return false;
  }
}

/**
 * Bounds for the required gate of a title/body edit run. It may start while the
 * same-input CI run is still running, so it waits for that run instead of
 * repeating it. The workflow step timeout must stay above `waitMs`.
 */
export const METADATA_GATE = {
  waitMs: 90 * 60_000,
  pollMs: 30_000,
  retryMs: 20_000,
  rejections: 3,
} as const;

export interface GateClock {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}
const realClock: GateClock = { now: () => Date.now(), sleep: (ms) => sleep(ms) };

function isReadyMetadataEdit(env: Record<string, string | undefined>, event: unknown): boolean {
  return (
    env.GITHUB_REPOSITORY === REPOSITORY &&
    isMetadataOnlyPrEdit(env.GITHUB_EVENT_NAME, event) &&
    object(object(event).pull_request).draft === false
  );
}

/** Cheap status polling only; the caller re-authenticates every outcome. */
async function untilProducerSettles(
  read: GitHubRead,
  producer: number,
  deadline: number,
  clock: GateClock
): Promise<void> {
  while (clock.now() < deadline) {
    await clock.sleep(Math.min(METADATA_GATE.pollMs, deadline - clock.now()));
    try {
      if (object(await read(`repos/${REPOSITORY}/actions/runs/${producer}`)).status === 'completed')
        return;
    } catch {
      return;
    }
  }
}

/**
 * Passes only after the canonical producer for the same head, base and merge
 * has completed full qualification. While it runs, only its run status is polled;
 * every decision is a fresh complete proof. A failed, cancelled or superseded
 * producer, a moved PR head or base, repeated proof failures and the deadline
 * all fail the gate, never pass or skip it.
 */
export async function awaitMetadataQualification(
  env: Record<string, string | undefined>,
  event: unknown,
  read: GitHubRead,
  clock: GateClock = realClock,
  log: (line: string) => void = console.log
): Promise<{ ok: boolean; reason: string }> {
  if (!isReadyMetadataEdit(env, event)) {
    return {
      ok: false,
      reason: 'Only a ready PR title/body edit can carry existing qualification',
    };
  }
  const deadline = clock.now() + METADATA_GATE.waitMs;
  let rejections = 0;
  for (;;) {
    const proof = await proveMetadataProducer(env, event, read);
    if (proof.state === 'completed') return { ok: true, reason: proof.reason };
    rejections = proof.state === 'rejected' ? rejections + 1 : 0;
    if (rejections >= METADATA_GATE.rejections) return { ok: false, reason: proof.reason };
    if (clock.now() >= deadline) {
      return { ok: false, reason: `Deadline reached before qualification: ${proof.reason}` };
    }
    if (proof.state === 'rejected') {
      log(`Metadata proof failed (${rejections}/${METADATA_GATE.rejections}): ${proof.reason}`);
      await clock.sleep(METADATA_GATE.retryMs);
    } else {
      // Re-proved only after the awaited run settles or a status read fails.
      log(`Waiting for https://github.com/${REPOSITORY}/actions/runs/${proof.producer}`);
      await untilProducerSettles(read, proof.producer, deadline, clock);
    }
  }
}

export async function planFeedback(
  env: Record<string, string | undefined>,
  event: unknown,
  read: GitHubRead,
  now = Date.now(),
  classify: (env: Record<string, string | undefined>) => ChangeClassification = collectChangeScope
): Promise<Plan> {
  const fallback: Plan = {
    scope: 'full',
    full: true,
    metadata: false,
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
  if (isMetadataOnlyPrEdit(env.GITHUB_EVENT_NAME, event)) {
    const ready = object(object(event).pull_request).draft === false;
    const proof = await proveMetadataProducer(env, event, read);
    const preserve = (reason: string): Plan => ({
      ...fallback,
      full: false,
      metadata: true,
      reason,
    });
    if (proof.state === 'completed' || (proof.state === 'pending' && !ready)) {
      return preserve(
        'Title/body edit with an authenticated same-head/base producer; preserve code checks'
      );
    }
    // A title/body edit that cannot reuse full evidence qualifies its unchanged
    // immutable diff again, so a focused PR stays focused.
    const change = classify(env);
    if (proof.state === 'pending' && change.scope === 'full') {
      // The required gate of this run waits for the running producer and then
      // demands its complete full evidence. Scoped evidence is never reused.
      return preserve(
        `Title/body edit while same-input CI run ${proof.producer} is running; the required gate waits for it`
      );
    }
    const unavailable = proof.state === 'rejected' ? `; no reusable producer: ${proof.reason}` : '';
    return { ...fallback, scope: change.scope, reason: `${change.reason}${unavailable}` };
  }
  // Base changes and unknown or malformed edits run full CI.
  try {
    if (env.GITHUB_EVENT_NAME === 'pull_request' && object(event).action === 'edited') {
      return fallback;
    }
  } catch {
    return fallback;
  }
  if (selectFeedbackMode(env.GITHUB_EVENT_NAME, event) === 'fast') {
    return { ...fallback, full: false, reason: 'Draft feedback' };
  }
  if (env.GITHUB_EVENT_NAME !== 'push') {
    const change = collectChangeScope(env);
    return { ...fallback, scope: change.scope, reason: change.reason };
  }
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
    if (
      plan.result !== 'success' ||
      outputs.metadata !== 'false' ||
      outputs.full !== full ||
      outputs.reuse !== reuse
    ) {
      throw new Error('Plan did not successfully bind gate mode');
    }
    if (
      reuse === 'true' &&
      (typeof outputs.source_run !== 'string' || !/^[1-9]\d*$/.test(outputs.source_run))
    ) {
      throw new Error('Reuse lacks authenticated source run');
    }
    const scope = outputs.scope ?? 'full';
    if (!['full', 'docs', 'assets', 'dmg', 'source'].includes(String(scope)))
      throw new Error('Invalid change scope');
    if (scope !== 'full' && reuse !== 'false')
      throw new Error('Scoped qualification cannot reuse full evidence');
    const required =
      scope === 'full'
        ? ['validate', 'test', 'lint', 'task-change-ledger-windows']
        : scope === 'source'
          ? ['source', 'test']
          : scope === 'dmg'
            ? ['focused', 'dmg-artwork']
            : ['focused'];
    for (const name of required) {
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
          : `Complete ${scope} qualification`,
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

function readEvent(): unknown {
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch {
    return null;
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
  if (process.argv[2] === 'metadata-gate') {
    const gate = await awaitMetadataQualification(process.env, readEvent(), read);
    console.log(
      gate.ok
        ? `Authenticated completed current-code qualification: ${gate.reason}`
        : `Metadata qualification failed: ${gate.reason}`
    );
    if (!gate.ok) process.exitCode = 1;
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
  if (process.argv[2] !== 'plan') {
    throw new Error('Expected plan, gate, metadata-gate, image or windows');
  }
  const plan = await planFeedback(process.env, readEvent(), read);
  output(
    `scope=${plan.scope ?? 'full'}\nfull=${plan.full}\nmetadata=${plan.metadata}\nreuse=${plan.reuse}\nsource_run=${plan.source_run}\nimage=${plan.image}\nlinux_arch=${plan.linux_arch}\n`
  );
  console.log(plan.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
