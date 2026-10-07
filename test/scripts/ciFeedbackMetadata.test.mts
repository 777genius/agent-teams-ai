import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planFeedback, qualifyFull } from '../../scripts/ci/ci-feedback.mts';
import { REPOSITORY, WORKFLOW } from '../../scripts/ci/ci-feedback-reuse.mts';
import type { JsonObject } from '../../scripts/ci/ci-feedback-reuse.mts';

const repository = { id: 1163183284, full_name: REPOSITORY };
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const env = {
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_SHA: 'c'.repeat(40),
  GITHUB_WORKFLOW_SHA: 'c'.repeat(40),
  GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW}@refs/pull/12/merge`,
  GITHUB_RUN_ID: '200',
  GITHUB_RUN_ATTEMPT: '1',
};
function event(changes: unknown = { body: { from: null } }, draft = false): JsonObject {
  return {
    action: 'edited',
    number: 12,
    repository,
    changes,
    pull_request: {
      id: 456,
      number: 12,
      state: 'open',
      draft,
      title: 'fix: preserve CI checks',
      body: 'Updated description',
      head: { sha: headSha, ref: 'fix/ci', repo: repository },
      base: { sha: baseSha, ref: 'main', repo: repository },
    },
  };
}
const prefix = `repos/${REPOSITORY}`;
const listEndpoint = `${prefix}/actions/workflows/789/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
const jobsEndpoint = `${prefix}/actions/runs/100/attempts/1/jobs?per_page=100`;
function runTitle(input: JsonObject, action = 'synchronize', merge = env.GITHUB_SHA): string {
  const pr = input.pull_request as JsonObject;
  return `CI proof: PR=12 | head=${(pr.head as JsonObject).sha} | base=${(pr.base as JsonObject).sha} | merge=${merge} | action=${action} | draft=${pr.draft}`;
}
function compactLink(side: unknown): JsonObject {
  const value = side as JsonObject;
  const repo = value.repo as JsonObject;
  const fullName = String(repo?.full_name);
  return { ...value, repo: { id: repo?.id, name: fullName.split('/')[1],
    url: `https://api.github.com/repos/${fullName}` } };
}
function fixture(input: JsonObject = event(), status = 'queued', shards: 2 | 4 = 2): Map<string, unknown> {
  const pr = input.pull_request as JsonObject;
  const run = (id: number, action: string): JsonObject => ({
    id, workflow_id: 789, path: WORKFLOW, event: 'pull_request', head_sha: headSha,
    run_attempt: 1, status: id === 200 ? 'in_progress' : status,
    conclusion: id === 100 && status === 'completed' ? 'success' : null,
    repository, head_repository: (pr.head as JsonObject).repo,
    display_title: runTitle(input, action),
    pull_requests: [{ number: 12, head: compactLink(pr.head), base: compactLink(pr.base) }],
  });
  const current = run(200, 'edited');
  const producer = run(100, pr.draft ? 'converted_to_draft' : 'synchronize');
  const step = (name: string): JsonObject => ({ name, status: 'completed', conclusion: 'success' });
  const names = ['plan', 'Fast feedback', 'validate', 'Full qualification',
    ...Array.from({ length: shards }, (_, index) => `test (${index + 1}/${shards})`), 'lint (main)', 'lint (renderer)', 'lint (features)', 'Task change ledger Windows smoke'];
  const jobs = status === 'completed' ? names.map((name, index) => ({
    id: index + 1, run_id: 100, run_attempt: 1, head_sha: headSha, name,
    status: 'completed', conclusion: name === 'Fast feedback' ? 'skipped' : 'success',
    steps: name === 'plan' ? [step(`CI source proof: PR=12 | base=${(pr.base as JsonObject).sha} | head=${headSha}`),
      step('Plan feedback and verify reusable evidence')]
      : name === 'Full qualification' ? [step('Require complete current-code qualification')] : [],
  })) : [];
  const bytes = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url));
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const workflow = { type: 'file', path: WORKFLOW, sha: blob };
  return new Map([
    [prefix, repository],
    [`${prefix}/git/commits/${env.GITHUB_SHA}`, { sha: env.GITHUB_SHA,
      parents: [{ sha: baseSha }, { sha: headSha }], tree: { sha: 'e'.repeat(40) } }],
    [`${prefix}/actions/workflows/ci.yml`, { id: 789, path: WORKFLOW, state: 'active' }],
    [`${prefix}/pulls/12`, pr],
    [`${prefix}/actions/runs/200`, current],
    [`${prefix}/actions/runs/100`, producer],
    [listEndpoint, { total_count: 2, workflow_runs: [current, producer] }],
    [jobsEndpoint, { total_count: jobs.length, jobs }],
    [`${prefix}/contents/${WORKFLOW}?ref=${env.GITHUB_WORKFLOW_SHA}`, workflow],
    [`${prefix}/contents/${WORKFLOW}?ref=${headSha}`, workflow],
  ]);
}
async function plan(input: unknown, override: Record<string, string | undefined> = {}, data?: Map<string, unknown>) {
  const responses = data ?? fixture(input as JsonObject);
  return planFeedback({ ...env, ...override }, input, async (endpoint) => {
    assert.ok(responses.has(endpoint), `Unexpected read: ${endpoint}`);
    return structuredClone(responses.get(endpoint));
  });
}

test('unchanged head with an advanced base requires full CI instead of preserving the old producer', async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const input = event();
    const data = fixture(input, status);
    (input.pull_request as JsonObject).base = { sha: 'd'.repeat(40), ref: 'main', repo: repository };
    data.set(`${prefix}/pulls/12`, structuredClone(input.pull_request));
    const current = data.get(`${prefix}/actions/runs/200`) as JsonObject;
    current.display_title = runTitle(input, 'edited');
    current.pull_requests = [{ number: 12, head: compactLink((input.pull_request as JsonObject).head),
      base: compactLink((input.pull_request as JsonObject).base) }];
    assert.equal((await plan(input, {}, data)).full, true);
  }
});

test('valid title/body edits skip heavy work for ready and draft PRs, including a null old body', async () => {
  for (const changes of [
    { title: { from: 'fix: previous title' } },
    { body: { from: null } },
    { body: { from: '' } },
    { title: { from: 'Old title' }, body: { from: 'Old body' } },
  ]) {
    for (const draft of [false, true]) {
      const decision = await plan(event(changes, draft));
      assert.equal(decision.full, false);
      assert.equal(decision.reuse, false);
      assert.equal(decision.metadata, true);
      assert.equal(decision.source_run, '');
    }
  }
  const emptyBody = event();
  (emptyBody.pull_request as JsonObject).body = null;
  assert.equal((await plan(emptyBody)).metadata, true);
  const fork = event();
  ((fork.pull_request as JsonObject).head as JsonObject).repo = {
    id: 789,
    full_name: 'contributor/agent-teams-ai',
  };
  assert.equal((await plan(fork)).full, false);
});

test('base, unknown or malformed edits conservatively require full qualification', async () => {
  for (const changes of [
    null,
    [],
    {},
    { base: { ref: { from: 'main' } } },
    { base: null },
    { body: { from: null }, base: null },
    { title: { from: 'Old title' }, unknown: {} },
    { title: {} },
    { title: { from: null } },
    { title: { from: '' } },
    { title: { from: '   ' } },
    { title: { from: 'Old\ntitle' } },
    { title: { from: 1 } },
    { body: {} },
    { body: { from: false } },
    { body: { from: null, unknown: true } },
  ]) {
    const decision = await plan(event(changes, true));
    assert.equal(decision.full, true, JSON.stringify(changes));
    assert.equal(decision.metadata, false);
  }
});

test('metadata skips require complete event identity and current metadata', async () => {
  const mutations: ((input: JsonObject, pr: JsonObject) => void)[] = [
    (input) => {
      input.repository = { ...repository, id: undefined };
    },
    (input) => {
      input.number = 13;
    },
    (_, pr) => {
      delete pr.id;
    },
    (_, pr) => {
      pr.state = 'closed';
    },
    (_, pr) => {
      delete pr.draft;
    },
    (_, pr) => {
      pr.title = '';
    },
    (_, pr) => {
      delete pr.title;
    },
    (_, pr) => {
      delete pr.body;
    },
    (_, pr) => {
      (pr.head as JsonObject).sha = 'bad';
    },
    (_, pr) => {
      (pr.base as JsonObject).sha = 'bad';
    },
    (_, pr) => {
      delete (pr.head as JsonObject).repo;
    },
    (_, pr) => {
      (pr.base as JsonObject).repo = { id: 999, full_name: REPOSITORY };
    },
    (_, pr) => {
      (pr.head as JsonObject).repo = { id: 789, full_name: 'invalid' };
    },
    (_, pr) => {
      (pr.head as JsonObject).repo = { id: 789, full_name: REPOSITORY };
    },
    (_, pr) => {
      (pr.head as JsonObject).repo = { id: repository.id, full_name: 'other/fork' };
    },
    (_, pr) => {
      delete (pr.base as JsonObject).ref;
    },
  ];
  for (const mutate of mutations) {
    const input = event();
    mutate(input, input.pull_request as JsonObject);
    assert.equal((await plan(input)).full, true);
  }
  for (const override of [
    { GITHUB_REPOSITORY: 'other/repository' },
    { GITHUB_SHA: 'bad' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
  ]) {
    assert.equal((await plan(event(), override)).full, true);
  }
  for (const action of ['ready_for_review', 'synchronize', 'reopened']) {
    assert.equal((await plan({ ...event(), action })).full, true);
  }
});

test('metadata, missing or failed plan outputs cannot create canonical full qualification success', () => {
  const needs = (metadata: unknown): JsonObject => ({
    plan: { result: 'success', outputs: { full: 'true', reuse: 'false', metadata } },
    validate: { result: 'success' },
    test: { result: 'success' },
    lint: { result: 'success' },
    'task-change-ledger-windows': { result: 'success' },
  });
  assert.equal(qualifyFull(needs('false'), 'true', 'false').ok, true);
  for (const value of ['true', undefined, null, 'unknown']) {
    assert.equal(qualifyFull(needs(value), 'true', 'false').ok, false);
  }
  for (const result of ['failure', 'skipped', 'cancelled', undefined]) {
    const input = needs('false');
    (input.plan as JsonObject).result = result;
    assert.equal(qualifyFull(input, 'true', 'false').ok, false);
  }
  const missing = needs('false');
  delete missing.plan;
  assert.equal(qualifyFull(missing, 'true', 'false').ok, false);
});

test('CLI without authenticated API access selects literal full execution outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-metadata-fixture-'));
  try {
    const eventFile = join(directory, 'event.json');
    const outputFile = join(directory, 'outputs');
    writeFileSync(eventFile, JSON.stringify(event()));
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/ci/ci-feedback.mts', import.meta.url)), 'plan'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          GITHUB_EVENT_PATH: eventFile,
          GITHUB_OUTPUT: outputFile,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          ImageOS: undefined,
          ImageVersion: undefined,
          RUNNER_ARCH: undefined,
        },
      }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(
      readFileSync(outputFile, 'utf8'),
      'full=true\nmetadata=false\nreuse=false\nsource_run=\nimage=unknown\nlinux_arch=unknown\n'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function source(data: Map<string, unknown>): JsonObject {
  return data.get(`${prefix}/actions/runs/100`) as JsonObject;
}
function jobs(data: Map<string, unknown>): JsonObject[] {
  return (data.get(jobsEndpoint) as JsonObject).jobs as JsonObject[];
}
function job(data: Map<string, unknown>, name: string): JsonObject {
  return jobs(data).find((item) => item.name === name)!;
}
function completedStep(name: string, conclusion = 'success'): JsonObject {
  return { name, status: 'completed', conclusion };
}
const heavySkips = [
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata lint') || 'lint') }} (${{ matrix.scope }})",
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata test') || 'test') }} (${{ matrix.shard }}/2)",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata validate' || 'validate'",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata Windows smoke' || 'Task change ledger Windows smoke'",
];
function draftFixture(shards: 2 | 4 = 2): Map<string, unknown> {
  const data = fixture(event(undefined, true), 'completed', shards);
  source(data).conclusion = 'failure';
  const plan = job(data, 'plan');
  const feedback = { ...plan, id: 2, name: 'Fast feedback',
    steps: ['Test feedback policy', 'Install dependencies', 'Guard runtime artifacts',
      'Guard production source file size', 'Guard Team Provisioning architecture',
      'Typecheck workspace', 'Fast lint'].map((name) => completedStep(name)), conclusion: 'success' };
  const gate = { ...plan, id: 3, name: 'Full qualification', conclusion: 'failure',
    steps: [completedStep('Require complete current-code qualification', 'failure')] };
  const skipped = heavySkips.map((name) => name.replace('/2)', `/${shards})`))
    .map((name, index) => ({ ...plan, id: 4 + index, name,
    conclusion: 'skipped', steps: [] }));
  data.set(jobsEndpoint, { total_count: 7, jobs: [plan, feedback, gate, ...skipped] });
  return data;
}

test('same-base queued empty-job and running producers avoid duplicate heavy work; green preserves it and legacy requires full', async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const data = fixture(event(), status);
    assert.equal((await plan(event(), {}, data)).metadata, true, status);
    if (status === 'completed') {
      source(data).display_title = 'A legacy workflow title';
      assert.equal((await plan(event(), {}, data)).full, true, 'legacy plan proof cannot bind actual synthetic merge');
    } else {
      source(data).display_title = 'A legacy workflow title';
      assert.equal((await plan(event(), {}, data)).full, true, 'legacy pending lacks proof');
    }
  }
});

test('bad or conflicting event attestations and workflow/repository/PR identity fail closed', async () => {
  const changes: ((data: Map<string, unknown>) => void)[] = [
    (data) => { source(data).display_title = runTitle(event()).replace('PR=12', 'PR=13'); },
    (data) => { source(data).display_title = runTitle(event()).replace(baseSha, 'd'.repeat(40)); },
    (data) => { source(data).display_title = runTitle(event()).replace(headSha, 'd'.repeat(40)); },
    (data) => { source(data).display_title = runTitle(event()).replace('draft=false', 'draft=true'); },
    (data) => { source(data).display_title = runTitle(event()).replace('synchronize', 'labeled'); },
    (data) => { source(data).display_title = runTitle(event()) + ' '; },
    (data) => { source(data).display_title = undefined; },
    (data) => { source(data).workflow_id = 790; },
    (data) => { source(data).path = '.github/workflows/other.yml'; },
    (data) => { source(data).event = 'pull_request_target'; },
    (data) => { source(data).repository = { id: 124, full_name: REPOSITORY }; },
    (data) => { source(data).head_repository = { id: 124, full_name: 'other/repo' }; },
    (data) => { source(data).pull_requests = []; },
    (data) => { source(data).pull_requests = [{ number: 13, head: {}, base: {} }]; },
    (data) => { source(data).status = 'unknown'; },
    (data) => { source(data).conclusion = 'failure'; },
    (data) => { (data.get(`${prefix}/actions/workflows/ci.yml`) as JsonObject).state = 'disabled_manually'; },
    (data) => { (data.get(`${prefix}/contents/${WORKFLOW}?ref=${headSha}`) as JsonObject).sha = baseSha; },
    (data) => { (data.get(`${prefix}/pulls/12`) as JsonObject).draft = true; },
    (data) => { (data.get(listEndpoint) as JsonObject).total_count = 100; },
    (data) => { (data.get(listEndpoint) as JsonObject).workflow_runs = [source(data), source(data)]; },
  ];
  for (const [index, mutate] of changes.entries()) {
    const data = fixture();
    mutate(data);
    assert.equal((await plan(event(), {}, data)).full, true, `mutation ${index}`);
  }
  for (const override of [
    { GITHUB_RUN_ID: undefined }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_WORKFLOW_SHA: undefined }, { GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW}@refs/heads/main` },
  ]) assert.equal((await plan(event(), override)).full, true);
  const unavailable = await planFeedback(env, event(), async () => { throw new Error('No auth'); });
  assert.equal(unavailable.full, true);
});

test('completed full producers require successful exact jobs and matching immutable plan proof, with no fallback past failure', async () => {
  const changes: ((data: Map<string, unknown>) => void)[] = [
    (data) => { source(data).conclusion = 'failure'; },
    (data) => { job(data, 'validate').conclusion = 'failure'; },
    (data) => { job(data, 'plan').conclusion = 'failure'; },
    (data) => { (job(data, 'plan').steps as JsonObject[])[0].name = `CI source proof: PR=12 | base=${'d'.repeat(40)} | head=${headSha}`; },
    (data) => { (job(data, 'plan').steps as JsonObject[])[0].conclusion = 'skipped'; },
    (data) => { (job(data, 'plan').steps as JsonObject[]).push((job(data, 'plan').steps as JsonObject[])[0]); },
    (data) => { job(data, 'plan').run_attempt = 2; },
    (data) => { job(data, 'Full qualification').steps = []; },
    (data) => { job(data, 'Fast feedback').conclusion = 'success'; },
    (data) => { jobs(data).pop(); },
  ];
  for (const [index, mutate] of changes.entries()) {
    const data = fixture(event(), 'completed');
    mutate(data);
    // An older green producer must not rescue the closest invalid one.
    const older = { ...source(data), id: 99, conclusion: 'success' };
    (data.get(listEndpoint) as JsonObject).total_count = 3;
    ((data.get(listEndpoint) as JsonObject).workflow_runs as JsonObject[]).push(older);
    data.set(`${prefix}/actions/runs/99`, older);
    assert.equal((await plan(event(), {}, data)).full, true, `mutation ${index}`);
  }
});

test('draft lifecycle continuity preserves fast feedback without allowing failed work or granting full qualification', async () => {
  const input = event(undefined, true);
  assert.equal((await plan(input, {}, draftFixture())).metadata, true);
  for (const mutate of [
    (data: Map<string, unknown>) => { job(data, 'Fast feedback').conclusion = 'failure'; },
    (data: Map<string, unknown>) => { job(data, 'plan').conclusion = 'failure'; },
    (data: Map<string, unknown>) => { jobs(data)[3].conclusion = 'failure'; },
    (data: Map<string, unknown>) => { jobs(data)[3].steps = [completedStep('Unexpected work')]; },
    (data: Map<string, unknown>) => { job(data, 'Full qualification').steps = [completedStep('Checkout', 'failure')]; },
    (data: Map<string, unknown>) => { jobs(data).push({ ...job(data, 'plan'), name: 'Unknown job' }); },
    (data: Map<string, unknown>) => { source(data).display_title = runTitle(input, 'ready_for_review'); },
    (data: Map<string, unknown>) => { source(data).display_title = 'Legacy draft'; },
  ]) {
    const data = draftFixture();
    mutate(data);
    assert.equal((await plan(input, {}, data)).full, true);
  }
  assert.equal(qualifyFull({ plan: { result: 'success', outputs: { full: 'false', metadata: 'true' } } }, 'false', 'false').ok, false);
});

test('pending metadata continuity reaches a canonical producer and never treats itself as qualification', async () => {
  const data = fixture();
  const producer = source(data);
  const intermediate = { ...producer, id: 150, display_title: runTitle(event(), 'edited') };
  const listing = data.get(listEndpoint) as JsonObject;
  (listing.workflow_runs as JsonObject[]).splice(1, 0, intermediate);
  listing.total_count = 3;
  data.set(`${prefix}/actions/runs/150`, intermediate);
  assert.equal((await plan(event(), {}, data)).metadata, true);
  producer.display_title = runTitle(event(), 'edited');
  assert.equal((await plan(event(), {}, data)).full, true);
});

test('rerun, listing and current base/head races invalidate metadata proof on final rereads', async () => {
  for (const target of [`${prefix}/actions/runs/100`, `${prefix}/actions/runs/200`, listEndpoint, `${prefix}/pulls/12`]) {
    const data = fixture();
    const reads = new Map<string, number>();
    const decision = await planFeedback(env, event(), async (endpoint) => {
      const count = (reads.get(endpoint) ?? 0) + 1;
      reads.set(endpoint, count);
      const response = structuredClone(data.get(endpoint)) as JsonObject;
      if (endpoint === target && count === 2) {
        if (target === listEndpoint) response.total_count = 3;
        else if (target.endsWith('/pulls/12')) (response.base as JsonObject).sha = 'd'.repeat(40);
        else response.run_attempt = 2;
      }
      return response;
    });
    assert.equal(decision.full, true, target);
  }
});

test('successful completed metadata can carry continuity only to an authenticated canonical producer', async () => {
  const input = event();
  const data = fixture();
  const metadataRun = { ...source(data), id: 150, status: 'completed', conclusion: 'success',
    display_title: runTitle(input, 'edited') };
  const baseJob = { id: 1, run_id: 150, run_attempt: 1, head_sha: headSha, status: 'completed' };
  const metadataJobs: JsonObject[] = [
    { ...baseJob, name: 'Metadata CI plan', conclusion: 'success', steps: [
      completedStep(`CI source proof: PR=12 | base=${baseSha} | head=${headSha}`),
      completedStep('Plan feedback and verify reusable evidence')] },
    { ...baseJob, id: 2, name: 'Metadata CI result', conclusion: 'success', steps: [
      completedStep('Preserve existing current-code checks after metadata edits'),
      completedStep('Require complete current-code qualification', 'skipped')] },
    ...[...heavySkips,
      "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata fast feedback' || 'Fast feedback'"]
      .map((name, index) => ({ ...baseJob, id: 3 + index, name, conclusion: 'skipped', steps: [] })),
  ];
  const endpoint = `${prefix}/actions/runs/150/attempts/1/jobs?per_page=100`;
  data.set(`${prefix}/actions/runs/150`, metadataRun);
  data.set(endpoint, { total_count: 7, jobs: metadataJobs });
  const listing = data.get(listEndpoint) as JsonObject;
  listing.total_count = 3;
  (listing.workflow_runs as JsonObject[]).splice(1, 0, metadataRun);
  assert.equal((await plan(input, {}, data)).metadata, true);
  const extraStep = completedStep('Unknown metadata command');
  (metadataJobs[1].steps as JsonObject[]).push(extraStep);
  assert.equal((await plan(input, {}, data)).full, true);
  (metadataJobs[1].steps as JsonObject[]).pop();
  source(data).conclusion = 'failure';
  assert.equal((await plan(input, {}, data)).full, true, 'metadata cannot cross a failed canonical run');
});

test('canonical producer search stays within eight earlier same-head runs', async () => {
  for (const count of [7, 8]) {
    const data = fixture();
    const listing = data.get(listEndpoint) as JsonObject;
    const runs = listing.workflow_runs as JsonObject[];
    for (let index = 0; index < count; index++) {
      const intermediate = { ...source(data), id: 120 + index,
        display_title: runTitle(event(), 'edited') };
      runs.push(intermediate);
      data.set(`${prefix}/actions/runs/${intermediate.id}`, intermediate);
    }
    listing.total_count = runs.length;
    assert.equal((await plan(event(), {}, data)).metadata, count === 7);
  }
});

// Sanitized compact repository shape captured from run 37628984764's PR linkage.
const capturedRunLinkRepo = {
  id: 1163183284,
  name: 'agent-teams-ai',
  url: 'https://api.github.com/repos/777genius/agent-teams-ai',
};
test('real GitHub compact PR-link repositories authenticate without full_name', async () => {
  assert.equal(Object.hasOwn(capturedRunLinkRepo, 'full_name'), false);
  for (const status of ['queued', 'in_progress', 'completed']) {
    const data = fixture(event(), status);
    for (const id of [100, 200]) {
      const run = data.get(`${prefix}/actions/runs/${id}`) as JsonObject;
      const link = (run.pull_requests as JsonObject[])[0];
      link.head = { ...(link.head as JsonObject), repo: { ...capturedRunLinkRepo } };
      link.base = { ...(link.base as JsonObject), repo: { ...capturedRunLinkRepo } };
    }
    assert.equal((await plan(event(), {}, data)).metadata, true, status);
  }
});

test('missing or conflicting compact linkage ids, names and exact API URLs fail closed', async () => {
  for (const id of [100, 200]) {
    for (const side of ['head', 'base']) {
      for (const patch of [
        { id: 999 }, { id: undefined }, { name: 'other-repo' }, { name: undefined },
        { url: 'https://api.github.com/repos/attacker/agent-teams-ai' },
        { url: 'https://api.github.com/repos/777genius/agent-teams-ai/' },
        { url: 'https://example.com/repos/777genius/agent-teams-ai' },
        { url: undefined }, { full_name: 'attacker/agent-teams-ai' },
      ]) {
        const data = fixture();
        const run = data.get(`${prefix}/actions/runs/${id}`) as JsonObject;
        const link = (run.pull_requests as JsonObject[])[0];
        const endpoint = link[side] as JsonObject;
        endpoint.repo = { ...(endpoint.repo as JsonObject), ...patch };
        assert.equal((await plan(event(), {}, data)).full, true,
          `${id}/${side}: ${JSON.stringify(patch)}`);
      }
    }
  }
});

function addNewerProducer(data: Map<string, unknown>, status: string, conclusion: unknown): JsonObject {
  const newer = { ...source(data), id: 300, status, conclusion };
  data.set(`${prefix}/actions/runs/300`, newer);
  const listing = data.get(listEndpoint) as JsonObject;
  (listing.workflow_runs as JsonObject[]).push(newer);
  listing.total_count = (listing.workflow_runs as JsonObject[]).length;
  if (status === 'completed') {
    const newerJobs = jobs(data).map((item) => ({ ...item, run_id: 300 }));
    data.set(`${prefix}/actions/runs/300/attempts/1/jobs?per_page=100`, {
      total_count: newerJobs.length, jobs: newerJobs,
    });
  }
  return newer;
}

test('already listed newer failed or unknown producers never fall back to older green CI', async () => {
  for (const [status, conclusion] of [['completed', 'failure'], ['unknown', null]]) {
    const data = fixture(event(), 'completed');
    addNewerProducer(data, String(status), conclusion);
    assert.equal((await plan(event(), {}, data)).full, true, String(status));
  }
});

test('newest attested same-base queued or running producer preserves checks despite an older failure', async () => {
  for (const status of ['queued', 'in_progress']) {
    const data = fixture(event(), 'completed');
    source(data).conclusion = 'failure';
    addNewerProducer(data, status, null);
    assert.equal((await plan(event(), {}, data)).metadata, true, status);
  }
});

test('newer producers with changed base, draft or malformed attestation still fail closed', async () => {
  for (const title of [
    runTitle(event()).replace(baseSha, 'd'.repeat(40)),
    runTitle(event()).replace('draft=false', 'draft=true'),
    runTitle(event()) + ' unexpected',
  ]) {
    const data = fixture(event(), 'completed');
    addNewerProducer(data, 'queued', null).display_title = title;
    assert.equal((await plan(event(), {}, data)).full, true, title);
  }
});

// Gate steps captured from TEST #845 run 37634869840. Identity fields are supplied
// by draftFixture; these are the observed completed GitHub step facts.
const capturedDraftGateSteps: JsonObject[] = [
  { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
  { number: 2, name: 'Set up runner', status: 'completed', conclusion: 'success' },
  { number: 3, name: 'Checkout', status: 'completed', conclusion: 'success' },
  { number: 4, name: 'Setup Node.js', status: 'completed', conclusion: 'success' },
  { number: 5, name: 'Preserve existing current-code checks after metadata edits', status: 'completed', conclusion: 'skipped' },
  { number: 6, name: 'Require complete current-code qualification', status: 'completed', conclusion: 'failure' },
  { number: 10, name: 'Post Setup Node.js', status: 'completed', conclusion: 'skipped' },
  { number: 11, name: 'Post Checkout', status: 'completed', conclusion: 'success' },
  { number: 12, name: 'Complete runner', status: 'completed', conclusion: 'success' },
  { number: 13, name: 'Complete job', status: 'completed', conclusion: 'success' },
];

test('observed successful draft feedback preserves checks when only Node post-cleanup is skipped after the deliberate failed gate', async () => {
  const data = draftFixture();
  job(data, 'Full qualification').steps = structuredClone(capturedDraftGateSteps);
  assert.equal((await plan(event(undefined, true), {}, data)).metadata, true);
});

test('draft cleanup exceptions never hide failed setup, missing source proof or unknown skipped work', async () => {
  const mutations: ((data: Map<string, unknown>, steps: JsonObject[]) => void)[] = [
    (_, steps) => { steps.find((step) => step.name === 'Setup Node.js')!.conclusion = 'failure'; },
    (_, steps) => { steps.find((step) => step.name === 'Setup Node.js')!.conclusion = 'skipped'; },
    (_, steps) => { steps.splice(steps.findIndex((step) => step.name === 'Setup Node.js'), 1); },
    (_, steps) => { steps.find((step) => step.name === 'Post Setup Node.js')!.conclusion = 'failure'; },
    (_, steps) => { steps.find((step) => step.name === 'Post Setup Node.js')!.name = 'Unknown post cleanup'; },
    (_, steps) => { steps.find((step) => step.name === 'Post Checkout')!.conclusion = 'skipped'; },
    (_, steps) => { steps.find((step) => step.name === 'Post Setup Node.js')!.number = 5; },
    (_, steps) => { delete steps.find((step) => step.name === 'Post Setup Node.js')!.number; },
    (_, steps) => { steps.push({ ...steps.find((step) => step.name === 'Post Setup Node.js')! }); },
    (data) => { (job(data, 'plan').steps as JsonObject[]).shift(); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const data = draftFixture();
    const steps = structuredClone(capturedDraftGateSteps);
    job(data, 'Full qualification').steps = steps;
    mutate(data, steps);
    assert.equal((await plan(event(undefined, true), {}, data)).full, true, `mutation ${index}`);
  }
});

test('four-shard metadata preservation authenticates the exact configured full and draft producer topology', async () => {
  const four = fixture(event(), 'completed', 4);
  assert.equal((await plan(event(), { CI_ROOT_TEST_SHARDS: '4' }, four)).metadata, true);
  assert.equal((await plan(event(), { CI_ROOT_TEST_SHARDS: '2' }, four)).full, true);
  assert.equal((await plan(event(), { CI_ROOT_TEST_SHARDS: '4' }, fixture(event(), 'completed'))).full, true);
  for (const name of ['test (1/4)', 'test (2/4)', 'test (3/4)', 'test (4/4)']) {
    const missing = fixture(event(), 'completed', 4);
    const response = missing.get(jobsEndpoint) as JsonObject;
    response.jobs = jobs(missing).filter((item) => item.name !== name);
    response.total_count = (response.jobs as JsonObject[]).length;
    assert.equal((await plan(event(), { CI_ROOT_TEST_SHARDS: '4' }, missing)).full, true, name);
  }
  const draft = draftFixture(4);
  job(draft, 'Full qualification').steps = structuredClone(capturedDraftGateSteps);
  assert.equal((await plan(event(undefined, true), { CI_ROOT_TEST_SHARDS: '4' }, draft)).metadata, true);
  assert.equal((await plan(event(undefined, true), { CI_ROOT_TEST_SHARDS: '2' }, draft)).full, true);
});

function forkFixture(status = 'queued'): { input: JsonObject; data: Map<string, unknown> } {
  const input = event();
  ((input.pull_request as JsonObject).head as JsonObject).repo = {
    id: 1213526556, full_name: 'sardorb3k/claude_agent_teams_ui',
  };
  const data = fixture(input, status);
  for (const id of [100, 200]) (data.get(`${prefix}/actions/runs/${id}`) as JsonObject).pull_requests = [];
  return { input, data };
}

test('authenticated true-fork runs preserve queued, running and completed producers with observed empty PR linkage', async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const { input, data } = forkFixture(status);
    assert.equal((await plan(input, {}, data)).metadata, true, status);
  }
});

test('empty fork linkage never excuses missing attestation, foreign identity or contradictory nonempty links', async () => {
  const mutations: ((data: Map<string, unknown>) => void)[] = [
    (data) => { source(data).display_title = 'Legacy unattested title'; },
    (data) => { source(data).display_title = runTitle(event()).replace(baseSha, 'd'.repeat(40)); },
    (data) => { source(data).display_title = runTitle(event()).replace('draft=false', 'draft=true'); },
    (data) => { source(data).repository = { id: 999, full_name: REPOSITORY }; },
    (data) => { source(data).head_repository = { id: 1213526556, full_name: 'attacker/other' }; },
    (data) => { delete source(data).pull_requests; },
    (data) => { source(data).pull_requests = {}; },
    (data) => { source(data).pull_requests = [{ number: 13, head: {}, base: {} }]; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const { input, data } = forkFixture('completed');
    mutate(data);
    assert.equal((await plan(input, {}, data)).full, true, `mutation ${index}`);
  }
  const sameRepository = fixture();
  for (const id of [100, 200]) (sameRepository.get(`${prefix}/actions/runs/${id}`) as JsonObject).pull_requests = [];
  assert.equal((await plan(event(), {}, sameRepository)).full, true);
});

test('fork empty-link decisions still reject final run, listing and current PR races', async () => {
  for (const target of [`${prefix}/actions/runs/100`, `${prefix}/actions/runs/200`, listEndpoint, `${prefix}/pulls/12`]) {
    const { input, data } = forkFixture();
    const reads = new Map<string, number>();
    const decision = await planFeedback(env, input, async (endpoint) => {
      const count = (reads.get(endpoint) ?? 0) + 1;
      reads.set(endpoint, count);
      const response = structuredClone(data.get(endpoint)) as JsonObject;
      if (endpoint === target && count === 2) {
        if (target === listEndpoint) response.total_count = 3;
        else if (target.endsWith('/pulls/12')) (response.head as JsonObject).sha = 'd'.repeat(40);
        else response.run_attempt = 2;
      }
      return response;
    });
    assert.equal(decision.full, true, target);
  }
});

test('same attested actual merge preserves checks even when the PR API base remains an older anchor', async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const data = fixture(event(), status);
    const merge = data.get(`${prefix}/git/commits/${env.GITHUB_SHA}`) as JsonObject;
    merge.parents = [{ sha: 'd'.repeat(40) }, { sha: headSha }];
    assert.equal((await plan(event(), {}, data)).metadata, true, status);
  }
});

test('same PR, head and stale base anchor with a different synthetic merge always requires full CI, including equal trees', async () => {
  const previousMerge = 'f'.repeat(40);
  for (const status of ['queued', 'in_progress', 'completed']) {
    const data = fixture(event(), status);
    const current = data.get(`${prefix}/git/commits/${env.GITHUB_SHA}`) as JsonObject;
    current.parents = [{ sha: 'd'.repeat(40) }, { sha: headSha }];
    data.set(`${prefix}/git/commits/${previousMerge}`, { sha: previousMerge,
      parents: [{ sha: baseSha }, { sha: headSha }], tree: structuredClone(current.tree) });
    source(data).display_title = runTitle(event(), 'synchronize', previousMerge);
    assert.equal((await plan(event(), {}, data)).full, true, status);
  }
});

test('legacy anchor-only attestations cannot preserve inputs after an implicit base advance', async () => {
  const data = fixture();
  const current = data.get(`${prefix}/git/commits/${env.GITHUB_SHA}`) as JsonObject;
  current.parents = [{ sha: 'd'.repeat(40) }, { sha: headSha }];
  for (const id of [100, 200]) {
    const run = data.get(`${prefix}/actions/runs/${id}`) as JsonObject;
    run.display_title = String(run.display_title).replace(` | merge=${env.GITHUB_SHA}`, '');
  }
  assert.equal((await plan(event(), {}, data)).full, true);
});

test('missing merge attestations and unauthenticated merge objects fail closed', async () => {
  const endpoint = `${prefix}/git/commits/${env.GITHUB_SHA}`;
  const mutations: ((data: Map<string, unknown>) => void)[] = [
    (data) => { source(data).display_title = String(source(data).display_title).replace(`merge=${env.GITHUB_SHA}`, 'merge=invalid'); },
    (data) => { source(data).display_title = String(source(data).display_title).replace(` | merge=${env.GITHUB_SHA}`, ''); },
    (data) => { (data.get(endpoint) as JsonObject).sha = 'f'.repeat(40); },
    (data) => { (data.get(endpoint) as JsonObject).parents = [{ sha: baseSha }]; },
    (data) => { (data.get(endpoint) as JsonObject).parents = [{ sha: baseSha }, { sha: headSha }, { sha: 'd'.repeat(40) }]; },
    (data) => { (data.get(endpoint) as JsonObject).parents = [{ sha: baseSha }, { sha: 'f'.repeat(40) }]; },
    (data) => { (data.get(endpoint) as JsonObject).parents = [{ sha: 'invalid' }, { sha: headSha }]; },
    (data) => { (data.get(endpoint) as JsonObject).tree = { sha: 'invalid' }; },
    (data) => { delete (data.get(endpoint) as JsonObject).tree; },
    (data) => { data.delete(endpoint); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const data = fixture();
    mutate(data);
    assert.equal((await plan(event(), {}, data)).full, true, `mutation ${index}`);
  }
  assert.equal((await plan(event(), { GITHUB_SHA: 'f'.repeat(40) })).full, true);
});
