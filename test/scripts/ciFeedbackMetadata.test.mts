import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  awaitMetadataQualification,
  METADATA_GATE,
  planFeedback,
  qualifyFull,
} from '../../scripts/ci/ci-feedback.mts';
import type { GateClock } from '../../scripts/ci/ci-feedback.mts';
import type { ChangeScope } from '../../scripts/ci/ci-change-scope.mts';
import { REPOSITORY, WORKFLOW } from '../../scripts/ci/ci-feedback-reuse.mts';
import type { GitHubRead, JsonObject } from '../../scripts/ci/ci-feedback-reuse.mts';

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
const baseRefEndpoint = `${prefix}/git/ref/heads/main`;
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
function fixture(input: JsonObject = event(), status = (input.pull_request as JsonObject).draft ? 'queued' : 'completed', shards: 2 | 4 = 2): Map<string, unknown> {
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
    [`${prefix}/git/ref/heads/${encodeURIComponent(String((pr.base as JsonObject).ref))}`, {
      ref: `refs/heads/${(pr.base as JsonObject).ref}`, object: { type: 'commit', sha: baseSha },
    }],
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
    ['rate_limit', { resources: { core: { limit: 1000, remaining: 1000, reset: 0 } } }],
  ]);
}
async function plan(input: unknown, override: Record<string, string | undefined> = {}, data?: Map<string, unknown>, scope?: ChangeScope) {
  const responses = data ?? fixture(input as JsonObject);
  return planFeedback({ ...env, ...override }, input, async (endpoint) => {
    assert.ok(responses.has(endpoint), `Unexpected read: ${endpoint}`);
    return structuredClone(responses.get(endpoint));
  }, Date.now(), scope ? () => ({ scope, paths: [], base: baseSha, head: headSha, reason: `Verified ${scope} diff` })
    : undefined);
}
// Virtual time: every gate sleep advances the clock at once. Yielding to the
// macrotask queue lets the test timeout fire if a broken wait loop never ends.
function virtualClock(): GateClock & { sleeps: number[] } {
  let time = 0;
  const sleeps: number[] = [];
  return { sleeps, now: () => time, sleep: (ms) => {
    sleeps.push(ms);
    time += ms;
    return new Promise((resolve) => setImmediate(resolve));
  } };
}
const quiet = (): undefined => undefined;
async function gate(input: unknown, read: GitHubRead, clock: GateClock = virtualClock(), override: Record<string, string | undefined> = {}): Promise<boolean> {
  return (await awaitMetadataQualification({ ...env, ...override }, input, read, clock, quiet)).ok;
}
function serve(data: Map<string, unknown>): GitHubRead {
  return (endpoint) => {
    assert.ok(data.has(endpoint), `Unexpected read: ${endpoint}`);
    return Promise.resolve(structuredClone(data.get(endpoint)));
  };
}
// Serves each phase from its start time on the gate clock.
function phases(clock: GateClock, timeline: [number, Map<string, unknown>][]): GitHubRead {
  return (endpoint) => {
    const data = timeline.filter(([start]) => clock.now() >= start).at(-1)![1];
    assert.ok(data.has(endpoint), `Unexpected read: ${endpoint}`);
    return Promise.resolve(structuredClone(data.get(endpoint)));
  };
}
// A broken wait loop must fail the suite instead of hanging the CI step.
const gateTimeout = { timeout: 10_000 };
const apiFailure = (): Promise<never> => Promise.reject(new Error('Authenticated GitHub API read failed'));

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
      'scope=full\nfull=true\nmetadata=false\nreuse=false\nsource_run=\nimage=unknown\nlinux_arch=unknown\n'
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

void test('ready metadata preserves completed or running attested producers; legacy producers require full CI', async () => {
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
  const intermediate = { ...producer, id: 150, status: 'in_progress', conclusion: null, display_title: runTitle(event(), 'edited') };
  const listing = data.get(listEndpoint) as JsonObject;
  (listing.workflow_runs as JsonObject[]).splice(1, 0, intermediate);
  listing.total_count = 3;
  data.set(`${prefix}/actions/runs/150`, intermediate);
  assert.equal((await plan(event(), {}, data)).metadata, true);
  producer.display_title = runTitle(event(), 'edited');
  producer.status = 'in_progress';
  producer.conclusion = null;
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
      const intermediate = { ...source(data), id: 120 + index, status: 'in_progress', conclusion: null,
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

void test('pending full producer never hides an older failure behind metadata qualification', gateTimeout, async () => {
  for (const status of ['queued', 'in_progress']) {
    const data = fixture(event(), 'completed');
    source(data).conclusion = 'failure';
    addNewerProducer(data, status, null);
    // The edit may wait for the newer run, but its gate cannot pass while it runs.
    assert.equal((await plan(event(), {}, data)).metadata, true, status);
    const clock = virtualClock();
    assert.equal(await gate(event(), serve(data), clock), false, status);
    assert.ok(clock.now() >= METADATA_GATE.waitMs, 'only the deadline ends a running producer');
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

function forkFixture(status = 'completed'): { input: JsonObject; data: Map<string, unknown> } {
  const input = event();
  ((input.pull_request as JsonObject).head as JsonObject).repo = {
    id: 1213526556, full_name: 'sardorb3k/claude_agent_teams_ui',
  };
  const data = fixture(input, status);
  for (const id of [100, 200]) (data.get(`${prefix}/actions/runs/${id}`) as JsonObject).pull_requests = [];
  return { input, data };
}

void test('authenticated true-fork linkage waits for the running producer and passes only on its completed full CI', gateTimeout, async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const { input, data } = forkFixture(status);
    assert.equal((await plan(input, {}, data)).metadata, true, status);
  }
  const running = forkFixture('in_progress');
  const done = forkFixture('completed');
  const clock = virtualClock();
  const read = phases(clock, [[0, running.data], [10 * 60_000, done.data]]);
  assert.equal(await gate(running.input, read, clock), true);
  assert.ok(clock.now() >= 10 * 60_000, 'the fork gate waited for completion');
  const failed = forkFixture('completed');
  source(failed.data).conclusion = 'failure';
  assert.equal(await gate(failed.input, serve(failed.data)), false);
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
    (data.get(baseRefEndpoint) as JsonObject).object = { type: 'commit', sha: 'd'.repeat(40) };
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


test('an advanced canonical target tip requires full CI even when PR anchor, head and attested merge are unchanged', async () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    const data = fixture(event(), status);
    (data.get(baseRefEndpoint) as JsonObject).object = { type: 'commit', sha: 'd'.repeat(40) };
    assert.equal((await plan(event(), {}, data)).full, true, status);
  }
});

test('target ref identity, commit type and valid tip are required on the initial read', async () => {
  const mutations: ((data: Map<string, unknown>) => void)[] = [
    (data) => { data.delete(baseRefEndpoint); },
    (data) => { data.set(baseRefEndpoint, null); },
    (data) => { (data.get(baseRefEndpoint) as JsonObject).ref = 'refs/heads/other'; },
    (data) => { delete (data.get(baseRefEndpoint) as JsonObject).ref; },
    (data) => { (data.get(baseRefEndpoint) as JsonObject).object = { type: 'tag', sha: baseSha }; },
    (data) => { (data.get(baseRefEndpoint) as JsonObject).object = { sha: baseSha }; },
    (data) => { (data.get(baseRefEndpoint) as JsonObject).object = { type: 'commit' }; },
    (data) => { (data.get(baseRefEndpoint) as JsonObject).object = { type: 'commit', sha: 'invalid' }; },
    (data) => { delete (data.get(baseRefEndpoint) as JsonObject).object; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const data = fixture();
    mutate(data);
    assert.equal((await plan(event(), {}, data)).full, true, `mutation ${index}`);
  }
});

test('final target ref advance, deletion or malformed identity invalidates unchanged producer proof', async () => {
  const finalResponses: unknown[] = [
    { ref: 'refs/heads/main', object: { type: 'commit', sha: 'd'.repeat(40) } },
    null,
    { ref: 'refs/heads/other', object: { type: 'commit', sha: baseSha } },
    { object: { type: 'commit', sha: baseSha } },
    { ref: 'refs/heads/main', object: { type: 'tag', sha: baseSha } },
    { ref: 'refs/heads/main', object: { type: 'commit' } },
    { ref: 'refs/heads/main', object: { type: 'commit', sha: 'invalid' } },
    { ref: 'refs/heads/main' },
  ];
  for (const [index, final] of finalResponses.entries()) {
    const data = fixture();
    let targetReads = 0;
    const decision = await planFeedback(env, event(), async (endpoint) => {
      assert.ok(data.has(endpoint), `Unexpected read: ${endpoint}`);
      if (endpoint === baseRefEndpoint && ++targetReads === 2) return structuredClone(final);
      return structuredClone(data.get(endpoint));
    });
    assert.equal(targetReads, 2, 'target ref must be reread after producer proof');
    assert.equal(decision.full, true, `final response ${index}`);
  }
  const data = fixture();
  let targetReads = 0;
  const unavailable = await planFeedback(env, event(), async (endpoint) => {
    if (endpoint === baseRefEndpoint && ++targetReads === 2) throw new Error('Ref deleted');
    return structuredClone(data.get(endpoint));
  });
  assert.equal(unavailable.full, true);
});

test('stale PR anchors preserve ready and deliberate draft producers only when actual merge base is the canonical tip', async () => {
  for (const draft of [false, true]) {
    for (const status of ['queued', 'completed']) {
      const input = event(undefined, draft);
      const data = draft && status === 'completed' ? draftFixture() : fixture(input, status);
      const actualBase = 'd'.repeat(40);
      (data.get(`${prefix}/git/commits/${env.GITHUB_SHA}`) as JsonObject).parents = [
        { sha: actualBase }, { sha: headSha },
      ];
      (data.get(baseRefEndpoint) as JsonObject).object = { type: 'commit', sha: actualBase };
      assert.equal((await plan(input, {}, data)).metadata, true, `${draft}/${status}`);
      (data.get(baseRefEndpoint) as JsonObject).object = { type: 'commit', sha: 'f'.repeat(40) };
      assert.equal((await plan(input, {}, data)).full, true, `${draft}/${status}/advanced`);
    }
  }
});

test('slash-containing target refs use an encoded API path and exact unencoded returned ref', async () => {
  const input = event();
  ((input.pull_request as JsonObject).base as JsonObject).ref = 'integration/ci-target';
  const data = fixture(input);
  const endpoint = `${prefix}/git/ref/heads/integration%2Fci-target`;
  const endpoints: string[] = [];
  const decision = await planFeedback(env, input, async (requested) => {
    endpoints.push(requested);
    assert.ok(data.has(requested), `Unexpected read: ${requested}`);
    return structuredClone(data.get(requested));
  });
  assert.equal(decision.metadata, true);
  assert.equal(endpoints.filter((requested) => requested === endpoint).length, 2);
  assert.equal(endpoints.includes(`${prefix}/git/ref/heads/integration/ci-target`), false);
  (data.get(endpoint) as JsonObject).ref = 'refs/heads/integration%2Fci-target';
  assert.equal((await plan(input, {}, data)).full, true);
});


void test('ready metadata never replaces an unfinished full producer with a successful required gate', gateTimeout, async () => {
  for (const status of ['queued', 'in_progress']) {
    const input = event();
    const running = fixture(input, status);
    // Heavy work is not repeated for a full-scope diff ...
    const decision = await plan(input, {}, running);
    assert.deepEqual([decision.full, decision.metadata, decision.reuse], [false, true, false], status);
    // ... but the required gate stays pending until the deadline and then fails.
    const clock = virtualClock();
    assert.equal(await gate(input, serve(running), clock), false, status);
    assert.ok(clock.now() >= METADATA_GATE.waitMs, status);
    assert.ok(clock.now() < METADATA_GATE.waitMs + METADATA_GATE.pollMs, 'bounded overrun');
    assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= METADATA_GATE.pollMs), 'bounded polling');
  }
});

void test('ready edits of scoped diffs rerun their scoped checks instead of waiting for a running producer', async () => {
  for (const scope of ['docs', 'assets', 'dmg', 'source'] as const) {
    const decision = await plan(event(), {}, fixture(event(), 'in_progress'), scope);
    assert.deepEqual([decision.scope, decision.full, decision.metadata], [scope, true, false], scope);
  }
  const full = await plan(event(), {}, fixture(event(), 'in_progress'), 'full');
  assert.deepEqual([full.full, full.metadata], [false, true]);
  // Completed full evidence and drafts keep their existing decisions.
  assert.equal((await plan(event(), {}, fixture(event(), 'completed'), 'docs')).metadata, true);
  assert.equal((await plan(event(undefined, true), {}, fixture(event(undefined, true), 'queued'), 'docs')).metadata, true);
});

void test('the edit gate passes only after the running producer completes its authenticated full qualification', gateTimeout, async () => {
  const input = event();
  const clock = virtualClock();
  const reads: string[] = [];
  const timeline = phases(clock, [[0, fixture(input, 'queued')], [5 * 60_000, fixture(input, 'in_progress')],
    [25 * 60_000, fixture(input, 'completed')]]);
  const result = await awaitMetadataQualification(env, input, (endpoint) => {
    reads.push(endpoint);
    return timeline(endpoint);
  }, clock, quiet);
  assert.equal(result.ok, true, result.reason);
  assert.ok(clock.now() >= 25 * 60_000, 'no success before the producer completed');
  assert.ok(clock.now() <= 25 * 60_000 + METADATA_GATE.pollMs, 'success follows completion promptly');
  // While waiting, only the producer status is read; the jobs are read once, on completion.
  assert.equal(reads.filter((endpoint) => endpoint === jobsEndpoint).length, 1);
  assert.ok(reads.filter((endpoint) => endpoint === `${prefix}/pulls/12`).length <= 4, 'light polling');
});

void test('the edit gate fails closed when the awaited producer fails, is cancelled, or the PR moves', gateTimeout, async () => {
  // Each phase has its own event and PR objects, so a mutation cannot leak into the event.
  const pr = (data: Map<string, unknown>): JsonObject => {
    const copy = structuredClone(data.get(`${prefix}/pulls/12`)) as JsonObject;
    data.set(`${prefix}/pulls/12`, copy);
    return copy;
  };
  const outcomes: [string, string, (data: Map<string, unknown>) => void][] = [
    ['failure', 'Canonical full producer did not succeed', (data) => { source(data).conclusion = 'failure'; }],
    ['cancelled', 'Canonical full producer did not succeed', (data) => {
      source(data).conclusion = 'cancelled'; job(data, 'Full qualification').conclusion = 'cancelled'; }],
    ['failed test shard', 'Canonical full producer did not succeed', (data) => { job(data, 'test (2/2)').conclusion = 'failure'; }],
    ['skipped heavy job', 'Canonical full producer did not succeed', (data) => { job(data, 'validate').conclusion = 'skipped'; }],
    ['force-push', 'Current PR inputs changed', (data) => { (pr(data).head as JsonObject).sha = 'd'.repeat(40); }],
    ['base advanced', 'Synthetic merge base is not the current target tip', (data) => {
      (data.get(baseRefEndpoint) as JsonObject).object = { type: 'commit', sha: 'd'.repeat(40) }; }],
    ['converted to draft', 'Current PR inputs changed', (data) => { pr(data).draft = true; }],
  ];
  for (const [name, reason, mutate] of outcomes) {
    const finished = fixture(event(), 'completed');
    mutate(finished);
    const clock = virtualClock();
    const read = phases(clock, [[0, fixture(event(), 'in_progress')], [10 * 60_000, finished]]);
    const result = await awaitMetadataQualification(env, event(), read, clock, quiet);
    assert.deepEqual(result, { ok: false, reason }, name);
    // Definitive outcomes fail after bounded re-proofs, long before the deadline.
    assert.ok(clock.now() >= 10 * 60_000, name);
    assert.ok(clock.now() <= 10 * 60_000 + METADATA_GATE.pollMs + METADATA_GATE.retryMs * METADATA_GATE.rejections, name);
  }
});

void test('the edit gate follows a newer same-input producer when the awaited one is superseded', gateTimeout, async () => {
  const input = event();
  const superseded = fixture(input, 'completed');
  source(superseded).conclusion = 'cancelled';
  addNewerProducer(superseded, 'in_progress', null).display_title = runTitle(input, 'reopened');
  const replaced = fixture(input, 'completed');
  source(replaced).conclusion = 'cancelled';
  addNewerProducer(replaced, 'completed', 'success').display_title = runTitle(input, 'reopened');
  for (const [final, expected] of [[replaced, true], [superseded, false]] as const) {
    const clock = virtualClock();
    const read = phases(clock, [[0, fixture(input, 'in_progress')], [5 * 60_000, superseded], [30 * 60_000, final]]);
    const result = await awaitMetadataQualification(env, input, read, clock, quiet);
    assert.equal(result.ok, expected, result.reason);
    if (!expected) assert.match(result.reason, /^Deadline reached before qualification: Same-input CI run 300 /);
    assert.ok(clock.now() >= 30 * 60_000, 'the newer producer was awaited');
  }
});

void test('transient proof failures are retried a bounded number of times', gateTimeout, async () => {
  const input = event();
  const data = fixture(input, 'completed');
  let failures = 1;
  const flaky: GitHubRead = (endpoint) =>
    endpoint === listEndpoint && failures-- > 0 ? apiFailure() : Promise.resolve(structuredClone(data.get(endpoint)));
  assert.equal(await gate(input, flaky), true);
  const clock = virtualClock();
  assert.equal(await gate(input, apiFailure, clock), false);
  assert.equal(clock.now(), METADATA_GATE.retryMs * (METADATA_GATE.rejections - 1));
});

void test('the gate re-proves after a failed status read and forgives proof failures separated by waiting', gateTimeout, async () => {
  const { pollMs, retryMs } = METADATA_GATE;
  // Status reads fail at three poll times; each failure forces a full re-proof that
  // fails too (same endpoint), so three rejections occur but never consecutively.
  const first = 3 * pollMs;
  const failing = [first, first + retryMs + 3 * pollMs, first + 2 * (retryMs + 3 * pollMs)];
  const completedAt = failing[2] + retryMs + 10 * pollMs;
  const clock = virtualClock();
  const timeline = phases(clock, [[0, fixture(event(), 'in_progress')], [completedAt, fixture(event(), 'completed')]]);
  const read: GitHubRead = (endpoint) =>
    endpoint === `${prefix}/actions/runs/100` && failing.includes(clock.now()) ? apiFailure() : timeline(endpoint);
  const result = await awaitMetadataQualification(env, event(), read, clock, quiet);
  assert.equal(result.ok, true, result.reason);
  assert.equal(clock.now(), completedAt);
  // A status read that keeps failing hands over to the full proof, which notices a moved head.
  const moved = fixture(event(), 'in_progress');
  ((moved.get(`${prefix}/pulls/12`) as JsonObject).head as JsonObject).sha = 'd'.repeat(40);
  const blind = virtualClock();
  const movedTimeline = phases(blind, [[0, fixture(event(), 'in_progress')], [5 * pollMs, moved]]);
  // A status poll reads the producer right after the budget check; a proof reads the repository first.
  let previous = '';
  const statusDown: GitHubRead = (endpoint) => {
    const poll = endpoint === `${prefix}/actions/runs/100` && previous === 'rate_limit';
    previous = endpoint;
    return poll ? apiFailure() : movedTimeline(endpoint);
  };
  const stopped = await awaitMetadataQualification(env, event(), statusDown, blind, quiet);
  assert.deepEqual(stopped, { ok: false, reason: 'Current PR inputs changed' });
  assert.ok(blind.now() < 10 * pollMs, 'no blind wait until the deadline');
});

void test('waiting gates pause instead of spending the reserved API budget', gateTimeout, async () => {
  // The budget is still low after the first reset, so the gate must check it again.
  const firstReset = 10 * 60_000;
  const resetAt = 20 * 60_000;
  const clock = virtualClock();
  const low = fixture(event(), 'completed');
  low.set('rate_limit', { resources: { core: { limit: 1000, remaining: 100, reset: firstReset / 1000 } } });
  const stillLow = fixture(event(), 'completed');
  stillLow.set('rate_limit', { resources: { core: { limit: 1000, remaining: 200, reset: resetAt / 1000 } } });
  const timeline = phases(clock, [[0, low], [firstReset, stillLow], [resetAt, fixture(event(), 'completed')]]);
  const reads: [number, string][] = [];
  const result = await awaitMetadataQualification(env, event(), (endpoint) => {
    reads.push([clock.now(), endpoint]);
    return timeline(endpoint);
  }, clock, quiet);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(reads.filter(([time, endpoint]) => time < resetAt && endpoint !== 'rate_limit'), []);
  assert.equal(reads.filter(([time]) => time < resetAt).length, 2, 'one budget read per pause');
  // An unreadable or malformed budget never blocks the gate.
  for (const budget of [undefined, null, { resources: {} }, { resources: { core: { remaining: 0 } } }]) {
    const data = fixture(event(), 'completed');
    if (budget === undefined) data.delete('rate_limit');
    else data.set('rate_limit', budget);
    const instant = virtualClock();
    const read: GitHubRead = (endpoint) => data.has(endpoint) ? Promise.resolve(structuredClone(data.get(endpoint))) : apiFailure();
    assert.equal(await gate(event(), read, instant), true, JSON.stringify(budget));
    assert.equal(instant.now(), 0);
  }
  // The pause is bounded by the deadline.
  const exhausted = fixture(event(), 'in_progress');
  exhausted.set('rate_limit', { resources: { core: { limit: 1000, remaining: 0, reset: 10 * METADATA_GATE.waitMs / 1000 } } });
  const bounded = virtualClock();
  assert.equal(await gate(event(), serve(exhausted), bounded), false);
  assert.ok(bounded.now() <= METADATA_GATE.waitMs + METADATA_GATE.pollMs);
});

void test('completed real metadata qualification preserves continuity to its completed full producer', async () => {
  const input = event();
  const data = fixture(input, 'completed');
  const prior = { ...source(data), id: 150, display_title: runTitle(input, 'edited') };
  const base = { run_id: 150, run_attempt: 1, head_sha: headSha, status: 'completed' };
  const previousJobs = [
    {
      ...base,
      id: 1,
      name: 'Metadata CI plan',
      conclusion: 'success',
      steps: [
        completedStep(`CI source proof: PR=12 | base=${baseSha} | head=${headSha}`),
        completedStep('Plan feedback and verify reusable evidence'),
      ],
    },
    {
      ...base,
      id: 2,
      name: 'Metadata qualification',
      conclusion: 'success',
      steps: [
        completedStep('Verify completed current-code qualification after metadata edits'),
        completedStep('Require complete current-code qualification', 'skipped'),
      ],
    },
    ...[
      ...heavySkips,
      "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata fast feedback' || 'Fast feedback'",
    ].map((name, index) => ({ ...base, id: index + 3, name, conclusion: 'skipped', steps: [] })),
  ];
  data.set(`${prefix}/actions/runs/150`, prior);
  data.set(`${prefix}/actions/runs/150/attempts/1/jobs?per_page=100`, {
    total_count: 7,
    jobs: previousJobs,
  });
  const listing = data.get(listEndpoint) as JsonObject;
  listing.total_count = 3;
  (listing.workflow_runs as JsonObject[]).splice(1, 0, prior);
  assert.equal((await plan(input, {}, data)).metadata, true);
  source(data).conclusion = 'failure';
  assert.equal((await plan(input, {}, data)).full, true);
});

void test('a Full qualification metadata run is crossed only when its gate re-authenticated the producer', async () => {
  const input = event();
  const withMetadataRun = (gate: 'success' | 'failure'): Map<string, unknown> => {
    const data = fixture(input, 'completed');
    const prior = { ...source(data), id: 150, conclusion: gate, display_title: runTitle(input, 'edited') };
    const base = { run_id: 150, run_attempt: 1, head_sha: headSha, status: 'completed' };
    const feedbackSkip =
      "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata fast feedback' || 'Fast feedback'";
    const previousJobs = [
      { ...base, id: 1, name: 'Metadata CI plan', conclusion: 'success', steps: [
        completedStep(`CI source proof: PR=12 | base=${baseSha} | head=${headSha}`),
        completedStep('Plan feedback and verify reusable evidence')] },
      { ...base, id: 2, name: 'Full qualification', conclusion: gate, steps: [
        completedStep('Verify completed current-code qualification after metadata edits', gate),
        completedStep('Require complete current-code qualification', 'skipped')] },
      ...[...heavySkips, feedbackSkip].map((name, index) =>
        ({ ...base, id: index + 3, name, conclusion: 'skipped', steps: [] })),
    ];
    data.set(`${prefix}/actions/runs/150`, prior);
    data.set(`${prefix}/actions/runs/150/attempts/1/jobs?per_page=100`, { total_count: 7, jobs: previousJobs });
    const listing = data.get(listEndpoint) as JsonObject;
    listing.total_count = 3;
    (listing.workflow_runs as JsonObject[]).splice(1, 0, prior);
    return data;
  };
  const passed = withMetadataRun('success');
  assert.equal((await plan(input, {}, passed)).metadata, true);
  // A newer title/body edit keeps head and base, so it does not invalidate the proof.
  passed.set(`${prefix}/pulls/12`, {
    ...structuredClone(input.pull_request as JsonObject), title: 'docs: edited again', body: 'Edited again',
  });
  assert.equal((await plan(input, {}, passed)).metadata, true);
  const read = (endpoint: string) => Promise.resolve(structuredClone(passed.get(endpoint)));
  assert.equal(await gate(input, read), true);
  // Skipped heavy jobs alone never make a failed metadata gate crossable.
  const failed = await plan(input, {}, withMetadataRun('failure'));
  assert.equal(failed.metadata, false);
  assert.equal(failed.full, true);
});

void test('metadata gate reauthenticates completed full evidence and rejects unfinished, missing-attempt and changed-source claims', gateTimeout, async () => {
  const input = event();
  const data = fixture(input, 'completed');
  const read = (endpoint: string) => Promise.resolve(structuredClone(data.get(endpoint)));
  assert.equal(await gate(input, read), true);
  for (const status of ['queued', 'in_progress']) {
    const pending = fixture(input, status);
    // A running producer cannot qualify: the gate waits and fails at its deadline.
    assert.equal(await gate(input, serve(pending)), false);
  }
  source(data).run_attempt = 2;
  const retained = jobs(data).filter((item) => item.name === 'Full qualification');
  data.set(`${prefix}/actions/runs/100/attempts/2/jobs?per_page=100`, {
    total_count: 1,
    jobs: retained,
  });
  assert.equal(
    await gate(input, read),
    false,
    'A gate-only rerun cannot invent missing producer jobs'
  );
  source(data).run_attempt = 1;
  job(data, 'test (1/2)').conclusion = 'failure';
  assert.equal(await gate(input, read), false);
  job(data, 'test (1/2)').conclusion = 'success';
  (data.get(`${prefix}/contents/${WORKFLOW}?ref=${headSha}`) as JsonObject).sha = 'f'.repeat(40);
  assert.equal(await gate(input, read), false);
  assert.equal(
    await gate(input, read, virtualClock(), { GITHUB_REPOSITORY: 'foreign/repository' }),
    false
  );
  assert.equal(await gate(event({ base: { from: 'other' } }), read), false);
  assert.equal(await gate(event(undefined, true), read), false);
});


test('full metadata producers permit only authenticated skipped scoped jobs', async () => {
  const input = event();
  const data = fixture(input, 'completed');
  const response = data.get(jobsEndpoint) as JsonObject;
  const currentJobs = jobs(data);
  const template = currentJobs[0];
  for (const name of ['Focused documentation and asset validation', 'Renderer source validation', 'macOS DMG artwork end-to-end']) {
    currentJobs.push({ ...template, id: currentJobs.length + 1, name, conclusion: 'skipped', steps: [] });
  }
  response.total_count = currentJobs.length;
  const read = (endpoint: string) => Promise.resolve(structuredClone(data.get(endpoint)));
  assert.equal(await gate(input, read), true);
  currentJobs[currentJobs.length - 1].conclusion = 'success';
  assert.equal(await gate(input, read), false);
});
