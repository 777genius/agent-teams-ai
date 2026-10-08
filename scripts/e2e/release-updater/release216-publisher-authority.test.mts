import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parse } from 'yaml';

import { checkPublisherExecution } from '../../ci/release/publisherExecution.ts';
import type { NativeArtifact, NativeJob, NativeRun } from '../../ci/release/nativeReadiness.ts';

const tooling = '80ad7936b6d602c89f712e14771911098277ec44';
const planDigest = '87207cedd0bf2a8a7fcee0ea44c876a04acea0873c30553b9da26bafa62f4c91';
// A test-only V identity; no accepted native policy or actual dispatch is created.
const execution = 'e'.repeat(40);
void test('publisher binds real dispatch/checkout independently from immutable original plan', () => {
  checkPublisherExecution(tooling, tooling, tooling, tooling, planDigest);
  checkPublisherExecution(tooling, execution, execution, execution, planDigest);
  assert.throws(() => checkPublisherExecution(tooling, execution, tooling, execution, planDigest));
  assert.throws(() => checkPublisherExecution(tooling, execution, execution, tooling, planDigest));
  assert.throws(() =>
    checkPublisherExecution(tooling, execution, execution, execution, '0'.repeat(64))
  );
  assert.throws(() =>
    checkPublisherExecution('a'.repeat(40), execution, execution, execution, planDigest)
  );
});

interface PreparedFixture {
  run: NativeRun;
  artifact: NativeArtifact & { size_in_bytes: number };
  jobs: { jobs: NativeJob[] };
}
function fixture(): PreparedFixture {
  const root = new URL('../../../test/fixtures/release216-publisher/', import.meta.url);
  return {
    run: JSON.parse(readFileSync(new URL('run.json', root), 'utf8')) as NativeRun,
    artifact: JSON.parse(
      readFileSync(new URL('artifact.json', root), 'utf8')
    ) as PreparedFixture['artifact'],
    jobs: JSON.parse(readFileSync(new URL('jobs.json', root), 'utf8')) as PreparedFixture['jobs'],
  };
}
function authenticate(data: PreparedFixture): number | null {
  const workflow = parse(
    readFileSync(
      new URL('../../../.github/workflows/publish-carried-release.yml', import.meta.url),
      'utf8'
    )
  ) as {
    jobs: { 'publish-reviewed-carry': { steps: { name?: string; run?: string }[] } };
  };
  const script = workflow.jobs['publish-reviewed-carry'].steps.find(
    (s) => s.name === 'Authenticate immutable prepared plan'
  )?.run;
  assert(script);
  const directory = mkdtempSync(path.join(tmpdir(), 'TEST-release216-publisher-'));
  try {
    for (const name of ['run', 'artifact', 'jobs'] as const)
      writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(data[name]));
    writeFileSync(
      path.join(directory, 'fixture.zip'),
      readFileSync(new URL('../../../test/fixtures/release216-publisher/plan.zip', import.meta.url))
    );
    // Isolated read-only transport fixtures; no real gh/git commands are executed.
    writeFileSync(
      path.join(directory, 'gh'),
      '#!/bin/sh\ncase "$2" in\n*/attempts/1/jobs*) cat jobs.json;;\n*/zip) cat fixture.zip;;\n*/runs/*) cat run.json;;\n*/artifacts/*) cat artifact.json;;\n*) exit 99;;\nesac\n',
      { mode: 0o700 }
    );
    writeFileSync(path.join(directory, 'git'), '#!/bin/sh\nprintf "%s\\n" "$GITHUB_SHA"\n', {
      mode: 0o700,
    });
    return spawnSync('/bin/bash', ['-c', script], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        GITHUB_REPOSITORY: '777genius/agent-teams-ai',
        GITHUB_SHA: execution,
        TOOLING_SHA: tooling,
        EXECUTION_SHA: execution,
        PREPARED_RUN_ID: '37614821129',
        PREPARED_ARTIFACT_ID: '11479573483',
        PLAN_DIGEST: planDigest,
        RELEASE_TAG: 'v2.17.6',
      },
      timeout: 30_000,
      encoding: 'utf8',
    }).status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
void test('actual publisher workflow authenticates independent official original prepared archive', () => {
  assert.equal(authenticate(fixture()), 0);
});
const negatives: [string, (data: PreparedFixture) => void][] = [
  [
    'spoofed prepared producer',
    (f) => {
      f.run.repository.full_name = 'foreign/repo';
    },
  ],
  [
    'wrong original producer head',
    (f) => {
      f.run.head_sha = execution;
    },
  ],
  [
    'old current attempt',
    (f) => {
      f.run.run_attempt = 2;
    },
  ],
  [
    'failed whole run',
    (f) => {
      f.run.conclusion = 'failure';
    },
  ],
  [
    'wrong immutable artifact',
    (f) => {
      f.artifact.id++;
    },
  ],
  [
    'wrong full ZIP',
    (f) => {
      f.artifact.digest = `sha256:${'0'.repeat(64)}`;
    },
  ],
  [
    'old producer job attempt',
    (f) => {
      const job = f.jobs.jobs[0];
      assert(job);
      job.run_attempt = 2;
    },
  ],
  [
    'missing original producer job',
    (f) => {
      f.jobs.jobs = [];
    },
  ],
  [
    'skipped prepare upload',
    (f) => {
      const job = f.jobs.jobs[0];
      assert(job);
      const upload = job.steps.find((s) => s.name === 'Persist immutable metadata plan');
      assert(upload);
      upload.conclusion = 'skipped';
    },
  ],
  [
    'artifact outside actual upload',
    (f) => {
      f.artifact.created_at = '2026-10-07T12:00:00Z';
    },
  ],
];
for (const [name, mutate] of negatives)
  void test(`publisher rejects ${name}`, () => {
    const data = fixture();
    mutate(data);
    assert.notEqual(authenticate(data), 0);
  });
