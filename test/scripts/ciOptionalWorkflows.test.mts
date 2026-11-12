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
      /pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]/
    );
    assert.match(trigger, /workflow_dispatch:/);
    const body = source.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
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
  assert.match(workflow('codeql'), /schedule:\n {4}- cron:/);
  for (const name of ['codeql', 'codex-runtime-smoke', 'runtime-bootstrap-smoke']) {
    assert.match(workflow(name), /push:\n {4}branches: \[main\]/);
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

test('selected retained V1/Host V2 acceptance is required by the existing Full qualification', () => {
  const source = workflow('ci');
  const job = source.split('\n  retained-opencode-coexistence:\n')[1]?.split(/\n {2}[\w-]+:\n/)[0];
  const gate = source.split('\n  full-qualification:\n')[1];
  assert.ok(job && gate);
  const selectedJob = job.match(/\n {4}if: >-\n([\s\S]*?)\n {4}runs-on:/)?.[1].trim();
  const selectedGate = gate.match(/Require selected retained V1 and Host V2 native Desktop qualification\n {8}if: >-\n([\s\S]*?)\n {8}env:/)?.[1].trim();
  assert.ok(selectedJob && selectedGate);
  assert.equal(selectedJob.replace(/\s+/g, ' '), selectedGate.replace(/\s+/g, ' '),
    'job selection and required-outcome selection cannot diverge');
  assert.match(selectedJob, /needs\.plan\.outputs\.full == 'true'/);
  assert.match(selectedJob, /needs\.plan\.outputs\.reuse == 'false'/);
  assert.match(selectedJob, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(gate, /needs: \[[^\]]*retained-opencode-coexistence[^\]]*\]/);
  assert.match(gate, /RETAINED_COEXISTENCE_RESULT: \$\{\{ needs\.retained-opencode-coexistence\.result \}\}/);
  assert.match(gate, /run: test "\$RETAINED_COEXISTENCE_RESULT" = success/);
  assert.doesNotMatch(job.split('\n    steps:\n')[0], /\$\{\{\s*runner\./,
    'runner context is unavailable before a job is allocated');
  assert.match(job, /printf 'TMPDIR=%s\\n' "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.doesNotMatch(job, /continue-on-error:/);
  assert.match(job, /OPENCODE_V1_V2_COEXISTENCE_GO: '1'/);
  assert.match(job, /node --test scripts\/legacy-agent-host\/desktop-retained-opencode-coexistence\.native\.ts/);
  assert.match(job, /assert\.equal\(r\.status, 'PASS'\); assert\.equal\(r\.cleanup, true\)/);
  assert.match(job, /path: \.runtime-download\/TEST-retained-runtime-source/);
  assert.match(job, /repository: 777genius\/agent_teams_orchestrator\n {10}ref: f5c69c2e9024ffc36a5db5eafe30f53539b52f62/);
  assert.match(job, /assert\.equal\(commit, 'f5c69c2e9024ffc36a5db5eafe30f53539b52f62'\)/);
  assert.match(job, /assert\.equal\(commit, lock\.opencodeV2Delivery\['linux-x64'\]\.sourceCommit\)/);
  assert.doesNotMatch(job, /steps\.retained-source\.outputs\./,
    'the stock helper checkout must never accept a source-derived repository or ref');
  const sqlite = job.split('      - name: Rebuild original SQLite for the pinned Electron ABI\n')[1]?.split('\n      - name:')[0];
  assert.ok(sqlite);
  assert.match(sqlite, /require\('electron\/package\.json'\)\.version, '44\.10\.1'/);
  assert.match(sqlite, /pnpm exec electron-rebuild --module-dir \. --force --only better-sqlite3 --version 44\.10\.1/);
  assert.doesNotMatch(sqlite, /--input-type/, 'node-gyp file children cannot inherit a stdin-only Node input type');
});
