import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SUPERSESSION_CANCEL, SUPERSESSION_GROUP } from '../workflows/runSupersession.mts';

const deferredJobs = {
  codeql: 'analyze',
  'codex-runtime-smoke': 'install',
  'runtime-bootstrap-smoke': 'bootstrap',
  'opencode-desktop-e2e': 'desktop',
  'opencode-packaged-e2e': 'packaged-windows',
  'anthropic-compatible-status-e2e': 'packaged-windows',
};
const workflow = (name: string) =>
  readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
// Exact text of the canonical policy; its semantics are proven by
// test/workflows/runSupersession.test.ts across every workflow.
const canonicalConcurrency = `\nconcurrency:\n  group: ${SUPERSESSION_GROUP}\n  cancel-in-progress: ${SUPERSESSION_CANCEL}\n`;

for (const [name, job] of Object.entries(deferredJobs)) {
  test(`${name}: defer drafts, run on Ready, and use canonical run supersession`, () => {
    const source = workflow(name);
    const trigger = source.split('\njobs:')[0];
    assert.match(
      trigger,
      /pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]/
    );
    assert.match(trigger, /workflow_dispatch:/);
    assert.ok(trigger.includes(canonicalConcurrency), `${name}: non-canonical concurrency`);
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

test('announcement validation still runs on drafts, with canonical run supersession', () => {
  const source = workflow('announcements-content');
  assert.ok(source.includes(canonicalConcurrency));
  assert.doesNotMatch(source, /draft/);
});

test('policy tests run before main CI planning, without dependency installation', () => {
  const source = workflow('ci').split('\n  feedback:')[0];
  assert.match(source, /node --test test\/scripts\/ciOptionalWorkflows.test.mts/);
  assert.ok(
    source.indexOf('ciOptionalWorkflows.test.mts') < source.indexOf('ci-feedback.mts plan')
  );
  assert.doesNotMatch(source, /Install dependencies/);
});
