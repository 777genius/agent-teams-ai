import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planFeedback, qualifyFull, selectFeedbackMode } from '../../scripts/ci/ci-feedback.mts';
import {
  MAX_AGE_MS,
  provePostmergeReuse,
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
    'task-change-ledger-windows': { result: reuse ? 'skipped' : 'success' },
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
    const command = windows
      ? 'Test task change ledger'
      : name.startsWith('lint')
        ? 'Lint source shard'
        : 'Test root shard';
    const runnerClass = windows ? 'windows-latest' : context.linuxRunner;
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
      steps: [
        {
          name:
            name === 'plan'
              ? `CI source proof: PR=12 | base=${baseSha} | head=${headSha}`
              : `CI runner proof: ${windows ? 'Windows' : 'Linux'} | X64 | ${runnerClass}`,
          status: 'completed',
          conclusion: 'success',
        },
        { name: command, status: 'completed', conclusion: 'success' },
      ],
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
    [`${prefix}/git/commits/${currentSha}`, { sha: currentSha, tree: { sha: treeSha } }],
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

const mutations: [string, (data: Map<string, unknown>) => void][] = [
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
      (job(data, 'Task change ledger Windows smoke').steps as JsonObject[])[1].conclusion =
        'skipped';
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
    assert.equal(readFileSync(outputFile, 'utf8'), 'full=false\nreuse=false\nsource_run=\n');
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
