import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planFeedback, qualifyFull } from '../../scripts/ci/ci-feedback.mts';
import { REPOSITORY } from '../../scripts/ci/ci-feedback-reuse.mts';
import type { JsonObject } from '../../scripts/ci/ci-feedback-reuse.mts';

const repository = { id: 123, full_name: REPOSITORY };
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const env = {
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_SHA: 'c'.repeat(40),
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
async function plan(input: unknown, override: Record<string, string | undefined> = {}) {
  return planFeedback({ ...env, ...override }, input, async () => {
    assert.fail('Metadata and conservative PR decisions must not contact GitHub');
  });
}

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

test('CLI exposes the metadata guard as a literal output with all execution flags disabled', () => {
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
      'full=false\nmetadata=true\nreuse=false\nsource_run=\nimage=unknown\nlinux_arch=unknown\n'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
