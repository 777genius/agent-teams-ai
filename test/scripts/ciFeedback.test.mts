import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  planFeedback,
  qualifyFull,
  selectFeedbackMode,
  windowsFeedback,
} from '../../scripts/ci/ci-feedback.mts';
import {
  MAX_AGE_MS,
  provePostmergeReuse,
  runnerImage,
  REPOSITORY,
  WORKFLOW,
} from '../../scripts/ci/ci-feedback-reuse.mts';
import type { JsonObject, ReuseContext } from '../../scripts/ci/ci-feedback-reuse.mts';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const currentSha = 'c'.repeat(40);
const treeSha = 'd'.repeat(40);
const workflowSha = 'e'.repeat(40);
const now = Date.parse('2026-10-07T12:00:00Z');
const recent = '2026-10-07T11:00:00Z';
const linuxImage = 'ubuntu24.04@20260901.1.0';
const windowsImage = 'win25@20260927.1.0';
const repository = { id: 123, full_name: REPOSITORY, default_branch: 'main' };
const prefix = `repos/${REPOSITORY}`;
const runEndpoint = `${prefix}/actions/runs/100`;
const jobsEndpoint = `${runEndpoint}/attempts/2/jobs?per_page=100`;
const listEndpoint = `${prefix}/actions/workflows/456/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
const context: ReuseContext = {
  repository: REPOSITORY,
  currentSha,
  linuxRunner: 'ubicloud-standard-4',
  linuxArch: 'X64',
  linuxImage,
  now,
};
const env = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_SHA: currentSha,
  GITHUB_WORKFLOW_SHA: currentSha,
  GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW}@refs/heads/main`,
  CI_LINUX_RUNNER: context.linuxRunner,
  RUNNER_ARCH: context.linuxArch,
  RUNNER_OS: 'Linux',
  ImageOS: 'ubuntu24.04',
  ImageVersion: '20260901.1.0',
};

function prEvent(action: string, draft: boolean): JsonObject {
  return {
    action,
    number: 12,
    repository,
    pull_request: {
      number: 12,
      state: 'open',
      draft,
      head: { sha: headSha },
      base: { sha: baseSha },
    },
  };
}

function fullNeeds(reuse = false): JsonObject {
  return {
    plan: {
      result: 'success',
      outputs: { full: 'true', reuse: String(reuse), source_run: reuse ? '100' : '' },
    },
    validate: { result: 'success' },
    test: { result: reuse ? 'skipped' : 'success' },
    lint: { result: reuse ? 'skipped' : 'success' },
    'task-change-ledger-windows': { result: 'success' },
  };
}

function fixture(shards: 2 | 4 = 2): Map<string, unknown> {
  const sourceRun = {
    id: 100,
    workflow_id: 456,
    run_attempt: 2,
    path: WORKFLOW,
    event: 'pull_request',
    head_sha: headSha,
    repository,
    head_repository: repository,
    status: 'completed',
    conclusion: 'success',
    created_at: recent,
    updated_at: recent,
    pull_requests: [
      {
        number: 12,
        head: { sha: headSha, repo: repository },
        base: { sha: baseSha, repo: repository },
      },
    ],
  };
  const names = [
    'plan',
    'Fast feedback',
    'validate',
    'Full qualification',
    ...Array.from({ length: shards }, (_, index) => `test (${index + 1}/${shards})`),
    'lint (main)',
    'lint (renderer)',
    'lint (features)',
    'Task change ledger Windows smoke',
  ];
  const jobs = names.map((name, index) => {
    const windows = name === 'Task change ledger Windows smoke';
    const runnerClass = windows ? 'windows-latest' : context.linuxRunner;
    const step = (name: string, conclusion = 'success'): JsonObject => ({
      name,
      status: 'completed',
      conclusion,
    });
    const commands = name.startsWith('test')
      ? [
          step('Rebuild test SQLite native module for Node'),
          step('Test workspace packages', name === `test (1/${shards})` ? 'success' : 'skipped'),
          step(
            'Test CI scripts and OpenCode proof runner safety',
            name === `test (1/${shards})` ? 'success' : 'skipped'
          ),
          step('Test root shard'),
          step('Test feedback policy', name === `test (1/${shards})` ? 'success' : 'skipped'),
        ]
      : name.startsWith('lint')
        ? [
            step('Restore ESLint cache'),
            step('Lint source shard'),
            step('Lint MCP package', name === 'lint (main)' ? 'success' : 'skipped'),
          ]
        : windows
          ? [
              step('Decide Windows reuse'),
              step('Test crash-safe app lock publication'),
              step('Test controller lock compatibility'),
              step('Test task change ledger'),
              step('Test startup cleanup deadline and late-response lifecycle'),
            ]
          : name === 'plan'
            ? [step('Plan feedback and verify reusable evidence')]
            : name === 'validate'
              ? [step('Audit dependencies'), step('Validate workspace truth gate')]
              : [step('Require complete current-code qualification')];
    const steps =
      name === 'Fast feedback'
        ? []
        : [
            step(
              name === 'plan'
                ? `CI source proof: PR=12 | base=${baseSha} | head=${headSha}`
                : `CI runner proof: ${windows ? 'Windows' : 'Linux'} | X64 | ${runnerClass}`
            ),
            step('Checkout'),
            step('Setup pnpm'),
            step('Setup Node.js'),
            step('Record runner image'),
            step(`CI image proof: ${windows ? windowsImage : linuxImage}`),
            step('Install dependencies'),
            ...commands,
            step('Post Checkout'),
          ].map((step, index) => ({ ...step, number: index + 1 }));
    return {
      id: index + 1,
      run_id: 100,
      run_attempt: 2,
      head_sha: headSha,
      name,
      status: 'completed',
      conclusion: name === 'Fast feedback' ? 'skipped' : 'success',
      completed_at: recent,
      runner_id: 200 + index,
      runner_name: `runner-${index}`,
      labels: [runnerClass],
      steps,
    };
  });
  return new Map<string, unknown>([
    [prefix, repository],
    [`${prefix}/actions/workflows/ci.yml`, { id: 456, path: WORKFLOW, state: 'active' }],
    [
      `${prefix}/commits/${currentSha}/pulls?per_page=100`,
      [{ number: 12, merge_commit_sha: currentSha }],
    ],
    [
      `${prefix}/pulls/12`,
      {
        number: 12,
        merged: true,
        state: 'closed',
        merge_commit_sha: currentSha,
        merged_at: recent,
        head: { sha: headSha, repo: repository },
        base: { ref: 'main', repo: repository },
      },
    ],
    [listEndpoint, { total_count: 1, workflow_runs: [sourceRun] }],
    [runEndpoint, sourceRun],
    [
      `${prefix}/compare/${baseSha}...${headSha}`,
      { status: 'ahead', base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha } },
    ],
    [
      `${prefix}/git/commits/${currentSha}`,
      { sha: currentSha, tree: { sha: treeSha }, parents: [{ sha: baseSha }] },
    ],
    [`${prefix}/git/commits/${headSha}`, { sha: headSha, tree: { sha: treeSha } }],
    [
      `${prefix}/contents/${WORKFLOW}?ref=${currentSha}`,
      { type: 'file', path: WORKFLOW, sha: workflowSha },
    ],
    [
      `${prefix}/contents/${WORKFLOW}?ref=${headSha}`,
      { type: 'file', path: WORKFLOW, sha: workflowSha },
    ],
    [jobsEndpoint, { total_count: jobs.length, jobs }],
  ]);
}

function record(data: Map<string, unknown>, key: string): JsonObject {
  return data.get(key) as JsonObject;
}

function job(data: Map<string, unknown>, name = 'test (1/2)'): JsonObject {
  return (record(data, jobsEndpoint).jobs as JsonObject[]).find((item) => item.name === name)!;
}

function imageStep(data: Map<string, unknown>, name = 'test (1/2)'): JsonObject {
  return (job(data, name).steps as JsonObject[]).find((step) =>
    String(step.name).startsWith('CI image proof:')
  )!;
}

async function proof(data = fixture(), inputs: ReuseContext = context) {
  return provePostmergeReuse(inputs, async (endpoint) => {
    assert.ok(data.has(endpoint), `Unexpected read: ${endpoint}`);
    return structuredClone(data.get(endpoint));
  });
}

test('draft transitions receive fast feedback; every ready transition receives full qualification', () => {
  for (const action of ['opened', 'synchronize', 'reopened', 'converted_to_draft']) {
    assert.equal(selectFeedbackMode('pull_request', prEvent(action, true)), 'fast');
  }
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    assert.equal(selectFeedbackMode('pull_request', prEvent(action, false)), 'full');
  }
});

test('unknown, contradictory and malformed lifecycle input fails closed', () => {
  for (const event of [
    null,
    [],
    {},
    { pull_request: { draft: true } },
    prEvent('edited', true),
    prEvent('ready_for_review', true),
    prEvent('converted_to_draft', false),
    { ...prEvent('opened', true), action: ['opened'] },
    { ...prEvent('opened', true), pull_request: { draft: true, number: 12, state: 'open' } },
    { ...prEvent('opened', true), repository: { full_name: 'someone/foreign' } },
  ]) {
    assert.equal(selectFeedbackMode('pull_request', event), 'full');
  }
  for (const name of ['push', 'merge_group', 'pull_request_target', undefined]) {
    assert.equal(selectFeedbackMode(name, prEvent('opened', true)), 'full');
  }
});

test('draft title/body edits keep fast feedback, while base or unknown edits require full CI', () => {
  for (const changes of [{ title: { from: 'Old title' } }, { body: { from: null } }]) {
    assert.equal(
      selectFeedbackMode('pull_request', { ...prEvent('edited', true), changes }),
      'fast'
    );
    assert.equal(
      selectFeedbackMode('pull_request', { ...prEvent('edited', false), changes }),
      'full'
    );
  }
  for (const changes of [
    {},
    { base: { ref: { from: 'main' } } },
    { title: { from: 1 } },
    { draft: { from: true } },
  ]) {
    assert.equal(
      selectFeedbackMode('pull_request', { ...prEvent('edited', true), changes }),
      'full'
    );
  }
});

test('only complete successful full jobs or verified eligible reuse can satisfy the gate', () => {
  assert.equal(qualifyFull(fullNeeds(), 'true', 'false').ok, true);
  assert.equal(qualifyFull(fullNeeds(true), 'true', 'true').ok, true);
  assert.equal(qualifyFull(fullNeeds(), 'false', 'false').ok, false);
  for (const outcome of ['skipped', 'failure', 'cancelled', 'neutral', undefined]) {
    for (const name of ['plan', 'validate', 'test', 'lint', 'task-change-ledger-windows']) {
      const needs = fullNeeds();
      (needs[name] as JsonObject).result = outcome;
      assert.equal(qualifyFull(needs, 'true', 'false').ok, false, `${name}: ${outcome}`);
    }
  }
  const missing = fullNeeds();
  delete missing.test;
  assert.equal(qualifyFull(missing, 'true', 'false').ok, false);
  const unbound = fullNeeds(true);
  ((unbound.plan as JsonObject).outputs as JsonObject).source_run = '';
  assert.equal(qualifyFull(unbound, 'true', 'true').ok, false);
  assert.equal(qualifyFull(fullNeeds(), 'true', 'true').ok, false);
  const staleValidate = fullNeeds(true);
  (staleValidate.validate as JsonObject).result = 'skipped';
  assert.equal(qualifyFull(staleValidate, 'true', 'true').ok, false);
  const skippedWindows = fullNeeds(true);
  (skippedWindows['task-change-ledger-windows'] as JsonObject).result = 'skipped';
  assert.equal(qualifyFull(skippedWindows, 'true', 'true').ok, false);
});

test('ordinary squash with exact inputs can reuse after GitHub drops PR links, while validate remains required', async () => {
  assert.deepEqual(await proof(), {
    reuse: true,
    sourceRun: '100',
    reason: 'Verified identical-input full CI',
  });
  const event = { ref: 'refs/heads/main', deleted: false, after: currentSha, repository };
  const data = fixture();
  record(data, runEndpoint).pull_requests = [];
  const plan = await planFeedback(env, event, async (endpoint) => data.get(endpoint), now);
  assert.equal(plan.full, true);
  assert.equal(plan.reuse, true);
  assert.equal(plan.source_run, '100');
});

test('all four successful root shards qualify reuse through Linux and Windows planning', async () => {
  const data = fixture(4);
  const read = async (endpoint: string): Promise<unknown> => {
    assert.ok(data.has(endpoint), `Unexpected read: ${endpoint}`);
    return structuredClone(data.get(endpoint));
  };
  assert.equal((await proof(data, { ...context, rootTestShards: '4' })).reuse, true);
  const plan = await planFeedback(
    { ...env, CI_ROOT_TEST_SHARDS: '4' },
    { ref: 'refs/heads/main', deleted: false, after: currentSha, repository },
    read,
    now
  );
  assert.equal(plan.full, true);
  assert.equal(plan.reuse, true);
  assert.equal(plan.source_run, '100');
  assert.equal(
    (
      await windowsFeedback(
        {
          ...env,
          CI_ROOT_TEST_SHARDS: '4',
          RUNNER_OS: 'Windows',
          RUNNER_ARCH: 'X64',
          MODE_REUSE: 'true',
          SOURCE_RUN: plan.source_run,
          ImageOS: 'win25',
          ImageVersion: '20260927.1.0',
          CI_LINUX_IMAGE: plan.image,
          CI_LINUX_ARCH: plan.linux_arch,
        },
        read,
        now
      )
    ).reuse,
    true
  );
  // toJSON(needs) exposes the matrix aggregate, not individual matrix cells.
  assert.equal(qualifyFull(fullNeeds(), 'true', 'false', '4').ok, true);
  assert.equal(qualifyFull(fullNeeds(true), 'true', 'true', '4').ok, true);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const needs = fullNeeds();
    (needs.test as JsonObject).result = result;
    assert.equal(qualifyFull(needs, 'true', 'false', '4').ok, false);
  }
  const missing = fullNeeds();
  delete missing.test;
  assert.equal(qualifyFull(missing, 'true', 'false', '4').ok, false);
});

test('four-shard reuse denies every missing or unsuccessful shard and skipped root command', async () => {
  const inputs = { ...context, rootTestShards: '4' };
  for (const name of ['test (1/4)', 'test (2/4)', 'test (3/4)', 'test (4/4)']) {
    const missing = fixture(4);
    const listing = record(missing, jobsEndpoint);
    listing.jobs = (listing.jobs as JsonObject[]).filter((item) => item.name !== name);
    listing.total_count = (listing.jobs as JsonObject[]).length;
    assert.equal((await proof(missing, inputs)).reuse, false, `Missing ${name}`);
    for (const conclusion of ['failure', 'cancelled', 'skipped']) {
      const data = fixture(4);
      job(data, name).conclusion = conclusion;
      assert.equal((await proof(data, inputs)).reuse, false, `${name}: ${conclusion}`);
    }
    const skipped = fixture(4);
    const rootStep = (job(skipped, name).steps as JsonObject[]).find(
      (step) => step.name === 'Test root shard'
    )!;
    rootStep.conclusion = 'skipped';
    assert.equal((await proof(skipped, inputs)).reuse, false, `${name}: skipped root command`);
    const changedImage = fixture(4);
    imageStep(changedImage, name).name = 'CI image proof: ubuntu24.04@20261001.1.0';
    assert.equal((await proof(changedImage, inputs)).reuse, false, `${name}: changed image`);
  }
});

test('reuse requires the configured shard topology, including the two-shard default', async () => {
  assert.equal((await proof(fixture(), { ...context, rootTestShards: '2' })).reuse, true);
  assert.equal((await proof(fixture(), { ...context, rootTestShards: '4' })).reuse, false);
  assert.equal((await proof(fixture(4))).reuse, false);
  const duplicate = fixture(4);
  job(duplicate, 'test (4/4)').name = 'test (3/4)';
  assert.equal((await proof(duplicate, { ...context, rootTestShards: '4' })).reuse, false);
});

test('invalid shard configuration fails closed before API reads and cannot qualify the gate', async () => {
  for (const count of ['', '3', '04', '4\n', 4, null, ['4']]) {
    let reads = 0;
    const result = await provePostmergeReuse({ ...context, rootTestShards: count }, async () => {
      reads++;
      return undefined;
    });
    assert.equal(result.reuse, false);
    assert.equal(reads, 0);
    assert.equal(qualifyFull(fullNeeds(), 'true', 'false', count).ok, false);
  }
  let reads = 0;
  const plan = await planFeedback(
    { ...env, GITHUB_EVENT_NAME: 'pull_request', CI_ROOT_TEST_SHARDS: '3' },
    prEvent('opened', true),
    async () => {
      reads++;
      return undefined;
    },
    now
  );
  assert.equal(plan.full, true);
  assert.equal(plan.reuse, false);
  assert.equal(reads, 0);
});

const mutations: [string, (data: Map<string, unknown>) => void][] = [
  [
    'source image changed with same runner class',
    (data) => {
      imageStep(data).name = 'CI image proof: ubuntu24.04@20261001.1.0';
    },
  ],
  [
    'source image missing',
    (data) => {
      job(data).steps = (job(data).steps as JsonObject[]).filter(
        (step) => step !== imageStep(data)
      );
    },
  ],
  [
    'source image unknown',
    (data) => {
      imageStep(data).name = 'CI image proof: unknown';
    },
  ],
  [
    'source image marker malformed',
    (data) => {
      imageStep(data).name = 'CI image proof:uubuntu24.04@20260901.1.0';
    },
  ],
  [
    'source image proof skipped',
    (data) => {
      imageStep(data).conclusion = 'skipped';
    },
  ],
  [
    'source image proof after commands',
    (data) => {
      imageStep(data).number = 100;
    },
  ],
  [
    'Windows image missing',
    (data) => {
      imageStep(data, 'Task change ledger Windows smoke').name = 'CI image proof: unknown';
    },
  ],
  [
    'squash parent drift with identical tree',
    (data) => {
      record(data, `${prefix}/git/commits/${currentSha}`).parents = [{ sha: treeSha }];
    },
  ],
  [
    'multiple merge parents',
    (data) => {
      record(data, `${prefix}/git/commits/${currentSha}`).parents = [
        { sha: baseSha },
        { sha: headSha },
      ];
    },
  ],
  [
    'missing merge parents',
    (data) => {
      delete record(data, `${prefix}/git/commits/${currentSha}`).parents;
    },
  ],
  [
    'missing root-shard workspace commands',
    (data) => {
      job(data).steps = (job(data).steps as JsonObject[]).filter(
        (step) => step.name !== 'Test workspace packages'
      );
    },
  ],
  [
    'missing Windows lock scenario',
    (data) => {
      const windows = job(data, 'Task change ledger Windows smoke');
      windows.steps = (windows.steps as JsonObject[]).filter(
        (step) => step.name !== 'Test crash-safe app lock publication'
      );
    },
  ],
  ['missing response', (data) => data.delete(prefix)],
  [
    'foreign repository',
    (data) => data.set(prefix, { ...repository, full_name: 'attacker/foreign' }),
  ],
  [
    'foreign workflow',
    (data) => {
      record(data, `${prefix}/actions/workflows/ci.yml`).path = 'other.yml';
    },
  ],
  [
    'workflow bytes mismatch',
    (data) => {
      record(data, `${prefix}/contents/${WORKFLOW}?ref=${headSha}`).sha = baseSha;
    },
  ],
  [
    'changed merge tree/lock/toolchain inputs',
    (data) => {
      record(data, `${prefix}/git/commits/${currentSha}`).tree = { sha: baseSha };
    },
  ],
  [
    'changed tested base',
    (data) => {
      record(data, `${prefix}/compare/${baseSha}...${headSha}`).merge_base_commit = {
        sha: treeSha,
      };
    },
  ],
  [
    'diverged base',
    (data) => {
      record(data, `${prefix}/compare/${baseSha}...${headSha}`).status = 'diverged';
    },
  ],
  [
    'malformed compare status',
    (data) => {
      record(data, `${prefix}/compare/${baseSha}...${headSha}`).status = ['ahead'];
    },
  ],
  [
    'missing immutable source proof',
    (data) => {
      (job(data, 'plan').steps as JsonObject[]).shift();
    },
  ],
  [
    'skipped immutable source proof',
    (data) => {
      (job(data, 'plan').steps as JsonObject[])[0].conclusion = 'skipped';
    },
  ],
  [
    'ambiguous immutable source proof',
    (data) => {
      const steps = job(data, 'plan').steps as JsonObject[];
      steps.push({ ...steps[0] });
    },
  ],
  [
    'source event PR mismatch',
    (data) => {
      (job(data, 'plan').steps as JsonObject[])[0].name =
        `CI source proof: PR=13 | base=${baseSha} | head=${headSha}`;
    },
  ],
  [
    'source event head mismatch',
    (data) => {
      (job(data, 'plan').steps as JsonObject[])[0].name =
        `CI source proof: PR=12 | base=${baseSha} | head=${treeSha}`;
    },
  ],
  [
    'present source base disagrees',
    (data) => {
      const links = record(data, runEndpoint).pull_requests as JsonObject[];
      (links[0].base as JsonObject).sha = treeSha;
    },
  ],
  [
    'foreign source PR',
    (data) => {
      record(data, runEndpoint).head_repository = { ...repository, id: 555 };
    },
  ],
  [
    'source was not merged',
    (data) => {
      record(data, `${prefix}/pulls/12`).merged = false;
    },
  ],
  [
    'expired source',
    (data) => {
      record(data, runEndpoint).created_at = new Date(now - MAX_AGE_MS - 1).toISOString();
    },
  ],
  [
    'future timestamp',
    (data) => {
      record(data, runEndpoint).updated_at = new Date(now + 1).toISOString();
    },
  ],
  [
    'partial run pagination',
    (data) => {
      record(data, listEndpoint).total_count = 101;
    },
  ],
  [
    'partial job pagination',
    (data) => {
      record(data, jobsEndpoint).total_count = 101;
    },
  ],
  [
    'missing required job',
    (data) => {
      const response = record(data, jobsEndpoint);
      (response.jobs as JsonObject[]).pop();
      response.total_count = 9;
    },
  ],
  [
    'duplicate job name',
    (data) => {
      job(data).name = 'test (2/2)';
    },
  ],
  [
    'failed latest attempt',
    (data) => {
      record(data, runEndpoint).conclusion = 'failure';
    },
  ],
  [
    'cancelled run',
    (data) => {
      record(data, runEndpoint).conclusion = 'cancelled';
    },
  ],
  [
    'partial rerun old job',
    (data) => {
      job(data).run_attempt = 1;
    },
  ],
  [
    'job from other head',
    (data) => {
      job(data).head_sha = baseSha;
    },
  ],
  [
    'skipped matrix job',
    (data) => {
      job(data).conclusion = 'skipped';
    },
  ],
  [
    'runner class changed',
    (data) => {
      job(data).labels = ['ubuntu-latest'];
    },
  ],
  [
    'actual OS mismatch',
    (data) => {
      (job(data).steps as JsonObject[])[0].name =
        'CI runner proof: Windows | X64 | ubicloud-standard-4';
    },
  ],
  [
    'runner proof skipped',
    (data) => {
      (job(data).steps as JsonObject[])[0].conclusion = 'skipped';
    },
  ],
  [
    'Windows commands skipped',
    (data) => {
      (job(data, 'Task change ledger Windows smoke').steps as JsonObject[]).find(
        (step) => step.name === 'Test task change ledger'
      )!.conclusion = 'skipped';
    },
  ],
  [
    'unknown command skipped',
    (data) => {
      (job(data).steps as JsonObject[]).push({
        name: 'Another scenario',
        status: 'completed',
        conclusion: 'skipped',
      });
    },
  ],
];
for (const [name, mutate] of mutations) {
  test(`reuse fails closed: ${name}`, async () => {
    const data = fixture();
    mutate(data);
    const result = await proof(data);
    assert.equal(result.reuse, false);
    assert.equal(result.sourceRun, '');
  });
}

test('newer failed run never falls back to old success and rerun race invalidates collected evidence', async () => {
  const data = fixture();
  (record(data, listEndpoint).workflow_runs as JsonObject[]).push({ id: 101 });
  record(data, listEndpoint).total_count = 2;
  data.set(`${prefix}/actions/runs/101`, {
    ...record(data, runEndpoint),
    id: 101,
    conclusion: 'failure',
  });
  assert.equal((await proof(data)).reuse, false);
  const stable = fixture();
  let runReads = 0;
  const result = await provePostmergeReuse(context, async (endpoint) => {
    const response = structuredClone(stable.get(endpoint));
    if (endpoint === runEndpoint && ++runReads > 1) (response as JsonObject).run_attempt = 3;
    return response;
  });
  assert.equal(result.reuse, false);
  let listReads = 0;
  const newer = await provePostmergeReuse(context, async (endpoint) => {
    const response = structuredClone(stable.get(endpoint));
    if (endpoint === listEndpoint && ++listReads > 1) {
      (response as JsonObject).workflow_runs = [{ id: 101 }];
    }
    return response;
  });
  assert.equal(newer.reuse, false);
});

for (const [status, conclusion] of [
  ['in_progress', null],
  ['completed', 'failure'],
]) {
  test(`final listing same run newer ${status}/${conclusion} attempt invalidates reuse`, async () => {
    const stable = fixture();
    let reads = 0;
    const result = await provePostmergeReuse(context, async (endpoint) => {
      const response = structuredClone(stable.get(endpoint));
      if (endpoint === listEndpoint && ++reads > 1) {
        const runs = (response as JsonObject).workflow_runs as JsonObject[];
        runs[0].run_attempt = 3;
        runs[0].status = status;
        runs[0].conclusion = conclusion;
      }
      return response;
    });
    assert.equal(result.reuse, false);
  });
}

test('final listing positively binds workflow, source head and repository as well as attempt', async () => {
  for (const override of [
    { workflow_id: 999 },
    { event: 'push' },
    { path: 'other.yml' },
    { head_sha: treeSha },
    { repository: { ...repository, id: 999 } },
    { head_repository: { ...repository, full_name: 'other/repo' } },
  ]) {
    const stable = fixture();
    let reads = 0;
    const result = await provePostmergeReuse(context, async (endpoint) => {
      const response = structuredClone(stable.get(endpoint));
      if (endpoint === listEndpoint && ++reads > 1) {
        Object.assign(((response as JsonObject).workflow_runs as JsonObject[])[0], override);
      }
      return response;
    });
    assert.equal(result.reuse, false);
  }
});

test('image identity requires actual standard build facts and never falls back to a class or ImageID', async () => {
  assert.equal(runnerImage({ ImageOS: 'ubuntu24.04', ImageVersion: '20260901.1.0' }), linuxImage);
  for (const invalid of [
    { ImageOS: 'ubuntu24.04' },
    { ImageVersion: '20260901.1.0' },
    { ImageID: linuxImage },
    { ImageOS: 'unknown', ImageVersion: '20260901.1.0' },
    { ImageOS: 'ubuntu24.04\nreuse=true', ImageVersion: '20260901.1.0' },
    { ImageOS: 'ubuntu24.04', ImageVersion: '20260901.1.0\n' },
  ]) {
    assert.equal(runnerImage(invalid), 'unknown');
  }
  const missing = await planFeedback(
    { ...env, ImageVersion: undefined },
    { ref: 'refs/heads/main', deleted: false, after: currentSha, repository },
    async () => {
      throw new Error('API must not be called for missing image');
    },
    now
  );
  assert.equal(missing.reuse, false);
  assert.equal(missing.image, 'unknown');
});

test('Windows reuses only the same authoritative source run with both current image identities', async () => {
  const windowsEnv = {
    ...env,
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
    MODE_REUSE: 'true',
    SOURCE_RUN: '100',
    ImageOS: 'win25',
    ImageVersion: '20260927.1.0',
    CI_LINUX_IMAGE: linuxImage,
    CI_LINUX_ARCH: 'X64',
  };
  const data = fixture();
  let reads = 0;
  const read = async (endpoint: string): Promise<unknown> => {
    reads++;
    return structuredClone(data.get(endpoint));
  };
  assert.equal((await windowsFeedback(windowsEnv, read, now)).reuse, true);
  assert.ok(reads > 0);
  for (const override of [
    { ImageVersion: '20261001.1.0' },
    { SOURCE_RUN: '101' },
    { CI_LINUX_IMAGE: 'ubuntu24.04@20261001.1.0' },
    { CI_LINUX_ARCH: 'ARM64' },
  ]) {
    assert.equal((await windowsFeedback({ ...windowsEnv, ...override }, read, now)).reuse, false);
  }
  for (const override of [
    { MODE_REUSE: 'false' },
    { SOURCE_RUN: '' },
    { SOURCE_RUN: 'not-an-id' },
    { ImageVersion: undefined },
    { CI_LINUX_IMAGE: 'unknown' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { RUNNER_OS: 'Linux' },
    { RUNNER_ARCH: 'ARM64' },
  ]) {
    reads = 0;
    assert.equal((await windowsFeedback({ ...windowsEnv, ...override }, read, now)).reuse, false);
    assert.equal(reads, 0);
  }
  imageStep(data, 'Task change ledger Windows smoke').name = 'CI image proof: win25@20261001.1.0';
  assert.equal((await windowsFeedback(windowsEnv, read, now)).reuse, false);
});

test('image and ordinary PR Windows CLI decisions expose safe outputs without contacting GitHub', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-image-fixture-'));
  const cli = fileURLToPath(new URL('../../scripts/ci/ci-feedback.mts', import.meta.url));
  try {
    const outputFile = join(directory, 'outputs');
    const run = (mode: string, override: Record<string, string | undefined>): string => {
      writeFileSync(outputFile, '');
      const child = spawnSync(process.execPath, [cli, mode], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ImageOS: 'win25',
          ImageVersion: '20260927.1.0',
          ImageID: undefined,
          MODE_REUSE: 'false',
          GITHUB_OUTPUT: outputFile,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          ...override,
        },
      });
      assert.equal(child.status, 0, child.stderr);
      return readFileSync(outputFile, 'utf8');
    };
    assert.equal(run('image', {}), `image=${windowsImage}\n`);
    assert.equal(
      run('image', { ImageVersion: undefined, ImageID: windowsImage }),
      'image=unknown\n'
    );
    assert.equal(run('windows', {}), `reuse=false\nimage=${windowsImage}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('network failure, malformed event, invalid SHA and non-main pushes select full execution', async () => {
  const event = { ref: 'refs/heads/main', deleted: false, after: currentSha, repository };
  for (const input of [
    null,
    {},
    { ...event, deleted: true },
    { ...event, ref: 'refs/heads/other' },
  ]) {
    assert.equal(
      (
        await planFeedback(
          env,
          input,
          async () => {
            throw new Error('No API expected');
          },
          now
        )
      ).reuse,
      false
    );
  }
  const failed = await planFeedback(
    env,
    event,
    async () => {
      throw new Error('Unavailable');
    },
    now
  );
  assert.equal(failed.full, true);
  assert.equal(failed.reuse, false);
  for (const override of [
    { GITHUB_WORKFLOW_REF: 'someone/other/ci.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_SHA: headSha },
    { GITHUB_WORKFLOW_REF: undefined },
  ]) {
    assert.equal(
      (await planFeedback({ ...env, ...override }, event, async () => null, now)).reuse,
      false
    );
  }
  assert.equal(
    (
      await planFeedback(
        { ...env, GITHUB_SHA: 'invalid' },
        prEvent('opened', true),
        async () => null
      )
    ).full,
    true
  );
});

test('CLI writes only literal outputs and fast feedback cannot pass the full CLI gate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-feedback-fixture-'));
  const cli = fileURLToPath(new URL('../../scripts/ci/ci-feedback.mts', import.meta.url));
  try {
    const eventFile = join(directory, 'event.json');
    const outputFile = join(directory, 'outputs');
    writeFileSync(eventFile, JSON.stringify(prEvent('opened', true)));
    const child = spawnSync(process.execPath, [cli, 'plan'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_OUTPUT: outputFile,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(
      readFileSync(outputFile, 'utf8'),
      `full=false\nreuse=false\nsource_run=\nimage=${linuxImage}\nlinux_arch=X64\n`
    );
    const gate = spawnSync(process.execPath, [cli, 'gate'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        JOB_RESULTS: JSON.stringify(fullNeeds()),
        MODE_FULL: 'false',
        MODE_REUSE: 'false',
      },
    });
    assert.equal(gate.status, 1);
    assert.match(gate.stdout, /does not qualify/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
