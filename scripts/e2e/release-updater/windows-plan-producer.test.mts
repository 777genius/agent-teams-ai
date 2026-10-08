import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateWindowsProducerUpload } from './windows-plan-producer.mts';

import type { WindowsProducerJob } from './windows-plan-producer.mts';

// Synthetic GitHub API clock/identity contract only; no native updater evidence.
const runId = 123;
const stepName = 'Upload immutable Windows native inputs';
function fixture(): WindowsProducerJob {
  return {
    id: 456,
    run_id: runId,
    name: 'prepare-windows-inputs',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-05T10:02:00Z',
    completed_at: '2026-10-05T10:06:00Z',
    steps: [
      {
        name: stepName,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-05T10:03:00Z',
        completed_at: '2026-10-05T10:04:00Z',
      },
    ],
  };
}
function check(job: WindowsProducerJob, created = '2026-10-05T10:03:30Z') {
  validateWindowsProducerUpload(job, runId, stepName, created);
}
function firstUpload(job: WindowsProducerJob) {
  const upload = job.steps[0];
  assert(upload);
  return upload;
}

void test('accepts selected upload through the inclusive one-second clock boundary', () => {
  const job = fixture();
  check(job, '2026-10-05T10:03:00Z');
  check(job, '2026-10-05T10:04:00.999Z');
  check(job, '2026-10-05T10:04:01Z');
});

for (const [name, created] of [
  ['before the selected job', '2026-10-05T10:01:00Z'],
  ['before the selected upload', '2026-10-05T10:02:59.999Z'],
  ['one millisecond beyond the upload precision boundary', '2026-10-05T10:04:01.001Z'],
  ['after the selected job', '2026-10-05T10:07:00Z'],
] as const) {
  void test(`rejects artifact creation ${name} even inside the former broad run window`, () => {
    assert(
      Date.parse(created) >= Date.parse('2026-10-05T10:00:00Z') &&
        Date.parse(created) <= Date.parse('2026-10-05T10:10:00Z')
    );
    assert.throws(() => check(fixture(), created), /selected successful producer upload/u);
  });
}

void test('rejects multiple named uploads, including a second unsuccessful upload', () => {
  for (const conclusion of ['success', 'failure']) {
    const job = fixture();
    const upload = job.steps[0];
    assert(upload);
    job.steps.push({ ...upload, conclusion });
    assert.throws(() => check(job), /ambiguous/u);
  }
});

void test('rejects a missing or unsuccessful named upload', () => {
  const missing = fixture();
  missing.steps = [];
  assert.throws(() => check(missing), /missing/u);
  for (const status of ['completed', 'in_progress']) {
    const job = fixture();
    const upload = job.steps[0];
    assert(upload);
    upload.status = status;
    upload.conclusion = 'failure';
    assert.throws(() => check(job), /unsuccessful/u);
  }
});

void test('rejects incomplete, invalid, and unordered job/upload clocks', () => {
  for (const mutate of [
    (job: WindowsProducerJob) => {
      job.started_at = 'invalid';
    },
    (job: WindowsProducerJob) => {
      job.completed_at = '';
    },
    (job: WindowsProducerJob) => {
      job.started_at = '2026-10-05T10:03:01Z';
    },
    (job: WindowsProducerJob) => {
      job.completed_at = '2026-10-05T10:03:59Z';
    },
    (job: WindowsProducerJob) => {
      firstUpload(job).started_at = '2026-10-05T10:04:01Z';
    },
    (job: WindowsProducerJob) => {
      firstUpload(job).completed_at = 'invalid';
    },
  ]) {
    const job = fixture();
    mutate(job);
    assert.throws(() => check(job), /selected successful producer upload/u);
  }
  assert.throws(() => check(fixture(), 'invalid'), /selected successful producer upload/u);
});

void test('rejects another run or a producer job that did not succeed', () => {
  const foreign = fixture();
  foreign.run_id++;
  assert.throws(() => check(foreign), /selected run/u);
  const failed = fixture();
  failed.conclusion = 'failure';
  assert.throws(() => check(failed));
  const running = fixture();
  running.status = 'in_progress';
  assert.throws(() => check(running));
});
