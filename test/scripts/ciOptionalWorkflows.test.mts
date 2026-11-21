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
  'teams-create-page-desktop-e2e': 'creation-page',
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

test('Windows console Electron GUI stages pinned prerequisites before boot', () => {
  // This policy test runs before dependencies are installed. Inspect the YAML
  // job/step structure by indentation, not comments or another job's text.
  const lines = workflow('windows-teammate-console-native').split('\n');
  const start = lines.indexOf('  windows-electron-console:');
  assert.ok(start >= 0, 'Windows Electron E2E job missing');
  const nextJob = lines.findIndex((line, i) => i > start && /^  [\w-]+:\s*$/.test(line));
  const job = lines.slice(start, nextJob < 0 ? lines.length : nextJob);
  const env = job.indexOf('    env:');
  const steps = job.indexOf('    steps:');
  assert.ok(env >= 0 && steps > env, 'Windows GUI job environment or steps missing');
  assert.ok(job.slice(env + 1, steps).includes('      AGENT_TEAMS_INSTALL_PROFILE: node-ci'),
    'The installer must inherit the node-ci profile');
  const commands = job.flatMap((line) => {
    const match = /^        run: (.+)$/.exec(line);
    return match && match[1] !== '|' ? [match[1]] : [];
  });
  let previous = -1;
  for (const command of [
    'node ./scripts/ci/install-dependencies-with-retry.mjs',
    'node ./scripts/ensure-electron-install.cjs --strict',
    'node ./scripts/ensure-terminal-platform-runtime.mjs',
    'node scripts/e2e/teams-create-page-desktop.mjs --windows-console-only',
  ]) {
    const index = commands.findIndex((value, i) => i > previous && value === command);
    assert.ok(index > previous, `Missing or out-of-order executable step: ${command}`);
    previous = index;
  }
});

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
  for (const name of ['codeql', 'codex-runtime-smoke', 'runtime-bootstrap-smoke', 'windows-teammate-console-native']) {
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

test('GitHub Pages: production deployment requires the main branch', () => {
  const source = workflow('landing');
  const mainOnly = "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'";
  assert.match(source, /  workflow_dispatch:\n/);
  for (const location of [
    /- uses: actions\/configure-pages@v6\n\s+if: ([^\n]+)/,
    /- uses: actions\/upload-pages-artifact@v5\n\s+if: ([^\n]+)/,
    /\n  deploy:\n[\s\S]*?\n    if: ([^\n]+)/,
    /\n  smoke:\n[\s\S]*?\n    if: ([^\n]+)/,
  ]) {
    assert.equal(source.match(location)?.[1], mainOnly);
  }
});
