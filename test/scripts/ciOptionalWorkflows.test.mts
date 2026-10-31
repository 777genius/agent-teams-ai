import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  RUN_SUPERSESSION_POLICY,
  SUPERSESSION_CANCEL,
  SUPERSESSION_GROUP,
} from '../workflows/runSupersession.mts';

const deferredJobs = {
  codeql: 'analyze',
  'codex-runtime-smoke': 'install',
  'runtime-bootstrap-smoke': 'bootstrap',
  'opencode-desktop-e2e': 'desktop',
  'opencode-packaged-e2e': 'packaged-windows',
  'anthropic-compatible-status-e2e': 'packaged-windows',
  'anthropic-env-portability': 'environment',
  'sentry-owned-process-native': 'native',
  'windows-backfill-diagnostic': 'packaged-backfill',
};
const workflow = (name: string) =>
  readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
// Exact text of the canonical run supersession policy. Its behavior for every
// event is evaluated by test/workflows/runSupersession.test.ts.
const canonicalConcurrency = `\nconcurrency:\n  group: ${SUPERSESSION_GROUP}\n  cancel-in-progress: ${SUPERSESSION_CANCEL}\n`;

for (const [name, job] of Object.entries(deferredJobs)) {
  test(`${name}: defer drafts and run on Ready`, () => {
    const source = workflow(name);
    const trigger = source.split('\njobs:')[0];
    assert.match(
      trigger,
      /pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]/
    );
    assert.match(trigger, /workflow_dispatch:/);
    const body = source.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
    assert.ok(body, `Missing ${job}`);
    assert.match(
      body,
      /if: \(?github.event_name != 'pull_request' \|\| github.event.pull_request.draft != true/
    );
  });
}

test('native packaged dispatch guards remain intact', () => {
  const source = workflow('opencode-packaged-e2e');
  assert.match(
    source,
    /\) && inputs.native_sdk_ref == '' && !inputs.native_source_only && !inputs.native_provider_only/
  );
  assert.equal(
    (
      source.match(
        /if: github.event_name == 'workflow_dispatch' && \(inputs.native_sdk_ref != '' \|\| inputs.native_source_only \|\| inputs.native_provider_only\)/g
      ) ?? []
    ).length,
    2
  );
});

test('security schedules and main push triggers remain available', () => {
  assert.match(workflow('codeql'), /schedule:\n    - cron:/);
  for (const name of ['codeql', 'codex-runtime-smoke', 'runtime-bootstrap-smoke']) {
    assert.match(workflow(name), /push:\n    branches: \[main\]/);
  }
});

test('announcement validation still runs on drafts', () => {
  assert.doesNotMatch(workflow('announcements-content'), /draft/);
});

test('automatic checks use the canonical run supersession policy verbatim', () => {
  for (const name of RUN_SUPERSESSION_POLICY.canonical) {
    const trigger = workflow(name).split('\njobs:')[0];
    assert.ok(trigger.includes(canonicalConcurrency), `${name}: non-canonical concurrency`);
  }
});

test('policy tests run before main CI planning, without dependency installation', () => {
  const source = workflow('ci').split('\n  feedback:')[0];
  assert.match(source, /node --test test\/scripts\/ciOptionalWorkflows.test.mts/);
  assert.ok(
    source.indexOf('ciOptionalWorkflows.test.mts') < source.indexOf('ci-feedback.mts plan')
  );
  assert.doesNotMatch(source, /Install dependencies/);
});
