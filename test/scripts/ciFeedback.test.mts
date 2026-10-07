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
      outputs: {
        full: 'true',
        metadata: 'false',
        reuse: String(reuse),
        source_run: reuse ? '100' : '',
      },
    },
    validate: { result: 'success' },
    test: { result: reuse ? 'skipped' : 'success' },
    lint: { result: reuse ? 'skipped' : 'success' },
    'task-change-ledger-windows': { result: 'success' },
  };
}

function fixture(): Map<string, unknown> {
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
    'test (1/2)',
    'test (2/2)',
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
          step('Test workspace packages', name === 'test (2/2)' ? 'skipped' : 'success'),
          step(
            'Test CI scripts and OpenCode proof runner safety',
            name === 'test (2/2)' ? 'skipped' : 'success'
          ),
          step('Test root shard'),
          step('Test feedback policy', name === 'test (2/2)' ? 'skipped' : 'success'),
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

async function proof(data = fixture()) {
  return provePostmergeReuse(context, async (endpoint) => {
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

// Observed jobs API name in successful GitHub run 37620209834: skipped
// conditional jobs can expose the exact unevaluated name expression.
const skippedFeedbackExpression =
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata fast feedback' || 'Fast feedback'";

function skippedExpressionFixture(): Map<string, unknown> {
  const data = fixture();
  job(data, 'Fast feedback').name = skippedFeedbackExpression;
  return data;
}

test('actual GitHub skipped feedback expression preserves authenticated full reuse', async () => {
  assert.deepEqual(await proof(skippedExpressionFixture()), {
    reuse: true,
    sourceRun: '100',
    reason: 'Verified identical-input full CI',
  });
});

test('skipped feedback alias cannot hide execution, malformed names or missing full jobs', async () => {
  const changes: ((data: Map<string, unknown>) => void)[] = [
    (data) => {
      job(data, skippedFeedbackExpression).conclusion = 'success';
    },
    (data) => {
      job(data, skippedFeedbackExpression).conclusion = 'failure';
    },
    (data) => {
      job(data, skippedFeedbackExpression).status = 'in_progress';
    },
    (data) => {
      job(data, skippedFeedbackExpression).name += ' ';
    },
    (data) => {
      job(data, skippedFeedbackExpression).name = '${{ ' + skippedFeedbackExpression + ' }}';
    },
    (data) => {
      job(data, skippedFeedbackExpression).name = 'Metadata fast feedback';
    },
    (data) => {
      job(data, 'Full qualification').name = skippedFeedbackExpression;
    },
    (data) => {
      const response = record(data, jobsEndpoint);
      response.jobs = (response.jobs as JsonObject[]).filter((item) => item.name !== 'test (1/2)');
      response.total_count = 9;
    },
    (data) => {
      record(data, `${prefix}/contents/${WORKFLOW}?ref=${headSha}`).sha = baseSha;
    },
  ];
  for (const change of changes) {
    const data = skippedExpressionFixture();
    change(data);
    assert.equal((await proof(data)).reuse, false);
  }
});

test('metadata result and skipped heavy jobs never qualify through the exact feedback alias', async () => {
  for (const renamePlan of [false, true]) {
    const data = skippedExpressionFixture();
    for (const item of record(data, jobsEndpoint).jobs as JsonObject[]) {
      if (item.name === skippedFeedbackExpression) continue;
      if (item.name === 'plan') {
        if (renamePlan) item.name = 'Metadata CI plan';
        continue;
      }
      if (item.name === 'Full qualification') {
        item.name = 'Metadata CI result';
        continue;
      }
      item.conclusion = 'skipped';
      item.steps = [];
    }
    assert.equal((await proof(data)).reuse, false);
  }
});

// Exact skipped job names recorded through gh for metadata run 37621422796.
const metadataSkippedNames = [
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata lint') || 'lint') }} (${{ matrix.scope }})",
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata test') || 'test') }} (${{ matrix.shard }}/2)",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata validate' || 'validate'",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata Windows smoke' || 'Task change ledger Windows smoke'",
  skippedFeedbackExpression,
];
function metadataFixture(count = 1): Map<string, unknown> {
  const data = skippedExpressionFixture();
  const runs = record(data, listEndpoint).workflow_runs as JsonObject[];
  for (let index = 1; index <= count; index++) {
    const run = structuredClone(record(data, runEndpoint));
    run.id = 100 + index;
    run.run_attempt = 1;
    runs.push(run);
    data.set(`${prefix}/actions/runs/${run.id}`, run);
    const step = (name: string, conclusion = 'success'): JsonObject => ({
      name, status: 'completed', conclusion,
    });
    const jobs = ['Metadata CI plan', 'Metadata CI result', ...metadataSkippedNames].map(
      (name, offset) => ({
        id: index * 10 + offset, run_id: run.id, run_attempt: 1, head_sha: headSha,
        name, status: 'completed', conclusion: offset < 2 ? 'success' : 'skipped',
        completed_at: recent,
        steps: offset === 0
          ? [step(`CI source proof: PR=12 | base=${baseSha} | head=${headSha}`),
              step('Plan feedback and verify reusable evidence')]
          : offset === 1
            ? [step('Preserve existing current-code checks after metadata edits'),
                step('Require complete current-code qualification', 'skipped')]
            : [],
      })
    );
    data.set(`${prefix}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`,
      { total_count: jobs.length, jobs });
  }
  record(data, listEndpoint).total_count = runs.length;
  return data;
}
function metadataJobs(data: Map<string, unknown>, id = 101): JsonObject[] {
  return record(data, `${prefix}/actions/runs/${id}/attempts/1/jobs?per_page=100`).jobs as JsonObject[];
}

test('proven metadata edits preserve the closest full qualification, including Windows selection', async () => {
  for (const count of [1, 3, 7]) {
    const data = metadataFixture(count);
    assert.equal((await proof(data)).reuse, true);
    const read = async (endpoint: string) => structuredClone(data.get(endpoint));
    assert.equal((await provePostmergeReuse({ ...context, sourceRun: '100', windowsImage }, read)).reuse, true);
    assert.equal((await provePostmergeReuse({ ...context, sourceRun: String(100 + count), windowsImage }, read)).reuse, false);
  }
  assert.equal((await proof(metadataFixture(8))).reuse, false);
  const closestFull = metadataFixture(2);
  const closerJobs = structuredClone(record(closestFull, jobsEndpoint).jobs) as JsonObject[];
  for (const item of closerJobs) { item.run_id = 101; item.run_attempt = 1; }
  closestFull.set(`${prefix}/actions/runs/101/attempts/1/jobs?per_page=100`,
    { total_count: closerJobs.length, jobs: closerJobs });
  assert.equal((await proof(closestFull)).sourceRun, '101');
  const droppedLinks = metadataFixture();
  record(droppedLinks, `${prefix}/actions/runs/101`).pull_requests = [];
  assert.equal((await proof(droppedLinks)).reuse, true);
});

test('only fully proven harmless metadata may precede full reuse', async () => {
  const changes: ((data: Map<string, unknown>) => void)[] = [
    (data) => { record(data, `${prefix}/actions/runs/101`).conclusion = 'failure'; },
    (data) => { record(data, `${prefix}/actions/runs/101`).conclusion = 'cancelled'; },
    (data) => { record(data, `${prefix}/actions/runs/101`).status = 'in_progress'; },
    (data) => { record(data, `${prefix}/actions/runs/101`).workflow_id = 999; },
    (data) => { record(data, `${prefix}/actions/runs/101`).head_sha = treeSha; },
    (data) => { record(data, `${prefix}/actions/runs/101`).repository = { ...repository, id: 999 }; },
    (data) => { record(data, `${prefix}/actions/runs/101`).created_at = new Date(now - MAX_AGE_MS - 1).toISOString(); },
    (data) => { (metadataJobs(data)[0].steps as JsonObject[])[0].name = `CI source proof: PR=12 | base=${treeSha} | head=${headSha}`; },
    (data) => { (metadataJobs(data)[0].steps as JsonObject[])[0].name = `CI source proof: PR=13 | base=${baseSha} | head=${headSha}`; },
    (data) => { (metadataJobs(data)[0].steps as JsonObject[])[1].conclusion = 'skipped'; },
    (data) => { metadataJobs(data)[0].run_attempt = 2; },
    (data) => { metadataJobs(data)[1].name = 'Full qualification'; },
    (data) => { (metadataJobs(data)[1].steps as JsonObject[])[0].conclusion = 'skipped'; },
    (data) => { (metadataJobs(data)[1].steps as JsonObject[])[1].conclusion = 'success'; },
    (data) => { metadataJobs(data)[2].steps = [{ name: 'Unexpected execution', status: 'completed', conclusion: 'success' }]; },
    (data) => { metadataJobs(data)[2].conclusion = 'success'; },
    (data) => { metadataJobs(data)[2].name += ' '; },
    (data) => { (metadataJobs(data)[1].steps as JsonObject[]).push({ name: 'Unknown step', status: 'completed', conclusion: 'success' }); },
    (data) => { metadataJobs(data)[2].name = metadataJobs(data)[3].name; },
    (data) => { metadataJobs(data).pop(); },
    (data) => { record(data, `${prefix}/contents/${WORKFLOW}?ref=${headSha}`).sha = baseSha; },
    (data) => { record(data, runEndpoint).conclusion = 'failure'; },
    (data) => {
      (metadataJobs(data)[0].steps as JsonObject[])[0].name = `CI source proof: PR=12 | base=${treeSha} | head=${headSha}`;
      ((record(data, `${prefix}/actions/runs/101`).pull_requests as JsonObject[])[0].base as JsonObject).sha = treeSha;
    },
    (data) => { job(data).conclusion = 'skipped'; },
  ];
  for (const [index, change] of changes.entries()) {
    const data = metadataFixture();
    change(data);
    assert.equal((await proof(data)).reuse, false, `Metadata mutation ${index}`);
  }
  for (const failure of ['failure', 'missing-test']) {
    const intervening = metadataFixture(2);
    const fullJobs = structuredClone(record(intervening, jobsEndpoint).jobs) as JsonObject[];
    for (const item of fullJobs) { item.run_id = 101; item.run_attempt = 1; }
    if (failure === 'failure') record(intervening, `${prefix}/actions/runs/101`).conclusion = 'failure';
    else fullJobs.splice(fullJobs.findIndex((item) => item.name === 'test (1/2)'), 1);
    intervening.set(`${prefix}/actions/runs/101/attempts/1/jobs?per_page=100`,
      { total_count: fullJobs.length, jobs: fullJobs });
    assert.equal((await proof(intervening)).reuse, false);
  }
});

test('reruns, changed metadata identity and listing races invalidate the entire reuse proof', async () => {
  const races: [string, (value: JsonObject) => void][] = [
    [`${prefix}/actions/runs/101`, (value) => { value.run_attempt = 2; }],
    [`${prefix}/actions/runs/101`, (value) => { value.conclusion = 'failure'; }],
    [`${prefix}/actions/runs/102`, (value) => { value.head_sha = treeSha; }],
    [`${prefix}/actions/runs/101`, (value) => {
      ((value.pull_requests as JsonObject[])[0].base as JsonObject).sha = treeSha;
    }],
    [runEndpoint, (value) => { value.run_attempt = 3; }],
    [listEndpoint, (value) => {
      (value.workflow_runs as JsonObject[])[2].run_attempt = 2;
    }],
    [listEndpoint, (value) => {
      (value.workflow_runs as JsonObject[]).push({ id: 104 }); value.total_count = 4;
    }],
    [listEndpoint, (value) => {
      (value.workflow_runs as JsonObject[]).pop(); value.total_count = 2;
    }],
  ];
  for (const [target, mutate] of races) {
    const data = metadataFixture(2);
    let reads = 0;
    const result = await provePostmergeReuse(context, async (endpoint) => {
      const value = structuredClone(data.get(endpoint));
      if (endpoint === target && ++reads > 1) mutate(value as JsonObject);
      return value;
    });
    assert.equal(result.reuse, false);
  }
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
      `full=false\nmetadata=false\nreuse=false\nsource_run=\nimage=${linuxImage}\nlinux_arch=X64\n`
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
