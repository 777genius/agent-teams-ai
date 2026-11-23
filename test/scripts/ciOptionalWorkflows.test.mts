import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
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


/**
 * Emulate GitHub's ordered workflow path evaluation for the small maintained
 * Kanban-exclusion policy. A later negative pattern withdraws a broad include;
 * any other matching positive path in the PR still schedules the workflow.
 */
function pathsForTrigger(name: string, event: 'pull_request' | 'push'): string[] {
  const lines = workflow(name).split('\n');
  const start = lines.indexOf('  ' + event + ':');
  assert.ok(start >= 0, name + ': missing ' + event);
  const end = lines.findIndex((line, i) => i > start && /^  [\w-]+:\s*$/.test(line));
  const block = lines.slice(start, end >= 0 ? end : lines.length);
  const paths = block.indexOf('    paths:');
  assert.ok(paths >= 0, name + ': missing path filter');
  const patterns: string[] = [];
  for (const line of block.slice(paths + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const entry = /^      - (.+)$/.exec(line);
    if (!entry) break;
    const value = entry[1].trim();
    patterns.push(value.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return patterns;
}

function selectedByPaths(patterns: string[], path: string): boolean {
  let selected = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith('!');
    if (matchesGlob(path, negative ? pattern.slice(1) : pattern)) selected = !negative;
  }
  return selected;
}

test('Kanban-only changes trigger dedicated E2E, not unrelated create/template E2E', () => {
  const kanban = 'src/renderer/components/team/kanban/KanbanBoard.tsx';
  const sharedTeam = 'src/renderer/components/team/TeamDetailView.tsx';
  const create = 'src/renderer/components/team/CreateTeamPage.tsx';
  const template = 'src/features/custom-team-templates/renderer/ui/CustomTemplateDialog.tsx';
  const scenarios = [
    ['custom-team-templates-desktop-e2e', ['pull_request'] as const],
    ['teams-create-page-desktop-e2e', ['pull_request', 'push'] as const],
  ] as const;
  for (const [name, events] of scenarios) {
    for (const event of events) {
      const paths = pathsForTrigger(name, event);
      const include = paths.indexOf('src/renderer/components/team/**');
      const exclude = paths.indexOf('!src/renderer/components/team/kanban/**');
      assert.ok(include >= 0 && exclude > include, name + ' must preserve ordered exclusion');
      assert.equal(selectedByPaths(paths, kanban), false, name + ': Kanban-only must skip');
      assert.equal(selectedByPaths(paths, sharedTeam), true, name + ': shared team must run');
      assert.equal(selectedByPaths(paths, create), true, name + ': create-page changes must run');
      assert.equal(selectedByPaths(paths, template), name === 'custom-team-templates-desktop-e2e');
      assert.equal(
        [kanban, sharedTeam].some((path) => selectedByPaths(paths, path)),
        true, name + ': combined Kanban and shared-team change must run',
      );
    }
  }
  for (const event of ['pull_request', 'push'] as const) {
    assert.equal(
      selectedByPaths(pathsForTrigger('kanban-table-desktop-e2e', event), kanban),
      true, 'dedicated Kanban E2E must keep all board changes',
    );
  }
});

test('heavy team-history and template E2E defer Draft but run on Ready/main/manual', () => {
  const gate = "if: github.event_name != 'pull_request' || github.event.pull_request.draft != true";
  for (const [name, job] of [
    ['custom-team-templates-desktop-e2e', 'desktop'],
    ['project-scoped-team-history-desktop-e2e', 'desktop-history'],
  ] as const) {
    const text = workflow(name);
    const trigger = text.split('\njobs:')[0];
    assert.match(trigger, /ready_for_review/);
    const body = text.split('\n  ' + job + ':\n')[1]?.split(/\n  [\w-]+:\n/)[0];
    assert.ok(body, name + ': missing native E2E job');
    assert.ok(body.includes(gate), name + ': must defer Draft');
    assert.doesNotMatch(body, /continue-on-error:\s*true/);
  }
  assert.match(workflow('custom-team-templates-desktop-e2e'), /workflow_dispatch:/);
  assert.match(workflow('project-scoped-team-history-desktop-e2e'), /  push:\n    branches: \[main\]/);
  assert.match(workflow('project-scoped-team-history-desktop-e2e'), /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
});


test('packaged policy selection and result gate free native Linux runner capacity', () => {
  const source = workflow('electron-packaged-ci');
  const job = (name: string): string => {
    const start = source.indexOf('\n  ' + name + ':\n');
    assert.ok(start >= 0, name + ': missing job');
    const after = source.slice(start + name.length + 5);
    const end = after.search(/\n  [a-z][\w-]*:\n/);
    return end < 0 ? after : after.slice(0, end);
  };
  const scope = job('packaged-scope');
  const smoke = job('packaged-smoke');
  const gate = job('packaged-full-gate');
  assert.match(scope, /^    runs-on: ubuntu-latest$/m);
  assert.match(gate, /^    runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(scope + gate, /vars\.CI_LINUX_RUNNER/);
  assert.match(scope, /node --test scripts\/ci\/packaged-ci-policy\.test\.mts/);
  assert.match(scope, /node scripts\/ci\/packaged-ci-cli\.mts classify/);
  assert.match(smoke, /^    runs-on: \$\{\{ matrix\.runner \}\}$/m);
  assert.match(smoke, /needs: packaged-scope/);
  assert.match(gate, /needs: \[packaged-scope, packaged-smoke\]/);
  assert.match(gate, /node scripts\/ci\/packaged-ci-cli\.mts gate/);
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64']) {
    assert.match(smoke, new RegExp('^          - platform: ' + platform + '$', 'm'));
  }
  assert.match(source, /ready_for_review/);
});

test('updater contract-only PR jobs do not reserve native Linux E2E runners', () => {
  for (const [name, job] of [
    ['updater-windows', 'tooling-quality'],
    ['updater-windows-ota', 'tooling-quality'],
    ['updater-linux-packages', 'linux-package-tooling-quality'],
  ] as const) {
    const source = workflow(name);
    const anchor = '\n  ' + job + ':\n';
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, name + ': missing original PR contract check');
    const after = source.slice(start + anchor.length);
    const next = after.search(/\n  [a-z][\w-]*:\n/);
    const body = next < 0 ? after : after.slice(0, next);
    assert.match(body, /^    if: github\.event_name == 'pull_request'$/m);
    assert.match(body, /^    runs-on: ubuntu-latest$/m);
    assert.doesNotMatch(body, /vars\.CI_LINUX_RUNNER/);
    assert.match(body, /pnpm typecheck/);
    assert.match(body, /pnpm lint:ci:files/);
    assert.match(source, /workflow_dispatch:/);
    assert.doesNotMatch(body, /continue-on-error:\s*true/);
  }
  for (const name of ['updater-windows', 'updater-windows-ota']) {
    assert.match(workflow(name), /  windows-predecessor:/);
  }
  assert.match(workflow('updater-windows-ota'), /  windows-ota:/);
  assert.match(workflow('updater-linux-packages'), /  native:/);
});

test('updater E2E launch environments disable MCP HTTP for current and legacy builds', () => {
  for (const name of [
    'mac-updater.mts',
    'mac-old-updater.mts',
    'mac-manual-migration.mts',
    'linux-feasibility.mts',
    'linux-ota.mts',
    'linux-packages.mts',
    'windows-ota-profile.mts',
  ]) {
    const source = readFileSync(
      new URL(`../../scripts/e2e/release-updater/${name}`, import.meta.url),
      'utf8'
    );
    assert.match(
      source,
      /AGENT_TEAMS_MCP_HTTP: '0',\r?\n[ \t]*CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',/,
      `${name} must disable current and predecessor MCP HTTP`
    );
  }
});
