// @vitest-environment node
// Run supersession invariants for every workflow (docs/ci-qualification.md#run-supersession).
// Concurrency expressions are evaluated against simulated event contexts, so the
// checks cover behavior rather than the literal text.
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { METADATA_GATE } from '../../scripts/ci/ci-feedback.mts';

import {
  evaluateWorkflowValue,
  type ExpressionValue,
  RUN_SUPERSESSION_POLICY,
  SUPERSESSION_GROUP,
} from './runSupersession.mts';

interface Step {
  name?: string;
  if?: string;
  run?: string;
  'timeout-minutes'?: number;
}

interface Workflow {
  name: string;
  triggers: string[];
  concurrency?: { group: unknown; cancel: unknown };
  jobs: Record<string, { name?: string; if?: unknown; steps?: Step[] }>;
}

function triggerNames(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on as Record<string, unknown>);
}

function readWorkflow(directory: URL, file: string): Workflow {
  const source = parse(readFileSync(new URL(file, directory), 'utf8'));
  const concurrency = source.concurrency as
    | string
    | { group: unknown; 'cancel-in-progress'?: unknown }
    | undefined;
  return {
    // Without a name, github.workflow is the workflow file path.
    name: String(source.name ?? `.github/workflows/${file}`),
    triggers: triggerNames(source.on),
    concurrency:
      typeof concurrency === 'string'
        ? { group: concurrency, cancel: false }
        : concurrency && {
            group: concurrency.group,
            cancel: concurrency['cancel-in-progress'] ?? false,
          },
    jobs: source.jobs,
  };
}

const directory = new URL('../../.github/workflows/', import.meta.url);
const workflows = new Map(
  readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [file.replace(/\.ya?ml$/, ''), readWorkflow(directory, file)] as const)
);

const policy = RUN_SUPERSESSION_POLICY;
const automatic = [...policy.canonical, ...policy.ci];
const superseding = [...automatic, ...policy.packaged, ...policy.pages];

interface Scenario {
  event: string;
  ref: string;
  run: number;
  payload: Record<string, ExpressionValue>;
}

// Fork PRs whose head branch is literally "main" must still group by PR number.
const pr = (number: number, run: number, payload: Record<string, ExpressionValue> = {}) => ({
  event: 'pull_request',
  ref: `refs/pull/${number}/merge`,
  run,
  payload: {
    action: 'synchronize',
    number,
    pull_request: { number, draft: false, head: { ref: 'main', repo: { fork: true } } },
    ...payload,
  },
});
const push = (ref: string, run: number) => ({
  event: 'push',
  ref,
  run,
  payload: { ref, repository: { default_branch: 'main' } },
});
const branch = (name: string, run: number) => push(`refs/heads/${name}`, run);
const dispatch = (run: number, ref = 'refs/heads/main') => ({
  event: 'workflow_dispatch',
  ref,
  run,
  payload: { ref, inputs: {} },
});
const schedule = (run: number) => ({
  event: 'schedule',
  ref: 'refs/heads/main',
  run,
  payload: { schedule: '34 3 * * 1' },
});
const queue = (number: number, run: number) => {
  const ref = `refs/heads/gh-readonly-queue/main/pr-${number}-${'a'.repeat(40)}`;
  return { event: 'merge_group', ref, run, payload: { merge_group: { head_ref: ref } } };
};
const release = (run: number) => ({
  event: 'release',
  ref: 'refs/tags/v9.9.9',
  run,
  payload: { action: 'published', release: { id: 7 } },
});

function concurrency(name: string, scenario: Scenario): { group: string; cancel: boolean } {
  const workflow = workflows.get(name)!;
  expect(workflow.concurrency, `${name} concurrency`).toBeDefined();
  const ref = scenario.ref;
  const context = {
    github: {
      workflow: workflow.name,
      event_name: scenario.event,
      ref,
      ref_name: ref.replace(/^refs\/(?:heads|tags|pull)\//, ''),
      ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
      run_id: String(scenario.run),
      repository: '777genius/agent-teams-ai',
      event: scenario.payload,
    },
    inputs: { release_tag: 'v9.9.9' },
  };
  const group = evaluateWorkflowValue(workflow.concurrency!.group, context);
  const cancel = evaluateWorkflowValue(workflow.concurrency!.cancel, context);
  expect(typeof group, `${name} group type`).toBe('string');
  expect(typeof cancel, `${name} cancel type`).toBe('boolean');
  return { group: group as string, cancel: cancel as boolean };
}

describe('run supersession policy', () => {
  it('classifies every workflow once and keeps group-prefixing names unique', () => {
    const classified = Object.values(policy).flat();
    expect(new Set(classified).size).toBe(classified.length);
    const byName = (left: string, right: string) => left.localeCompare(right);
    expect([...workflows.keys()].sort(byName)).toEqual([...classified].sort(byName));
    const names = [...workflows.values()].map((workflow) => workflow.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  // ciOptionalWorkflows.test.mts checks the canonical text early, without dependencies.
  it('extends the canonical group for CI', () => {
    const ci = String(workflows.get('ci')!.concurrency!.group);
    expect(ci.startsWith(`${SUPERSESSION_GROUP}-`), ci).toBe(true);
  });

  it.each(superseding)('%s: a new PR revision cancels only that PR', (name) => {
    const older = concurrency(name, pr(7, 101));
    const newer = concurrency(name, pr(7, 102));
    expect(newer).toEqual({ group: older.group, cancel: true });
    expect(concurrency(name, pr(8, 103)).group).not.toBe(older.group);
    expect(concurrency(name, branch('main', 104)).group).not.toBe(older.group);
  });

  it.each(automatic)(
    '%s: default-branch, release, tag, scheduled and manual runs stay independent',
    (name) => {
      for (const make of [
        (run: number) => branch('main', run),
        (run: number) => ({ ...branch('main', run), payload: { ref: 'refs/heads/main' } }),
        (run: number) => branch('release/2.19', run),
        (run: number) => push('refs/tags/v2.19.0', run),
        schedule,
        dispatch,
        (run: number) => dispatch(run, 'refs/heads/feature'),
      ]) {
        const first = concurrency(name, make(201));
        const second = concurrency(name, make(202));
        expect(second.cancel, `${make(0).event} ${make(0).ref}`).toBe(false);
        expect(second.group, `${make(0).event} ${make(0).ref}`).not.toBe(first.group);
      }
    }
  );

  it.each(automatic)(
    '%s: other branch pushes supersede by ref, merge queue isolates by ref',
    (name) => {
      const older = concurrency(name, branch('refactor/x', 301));
      expect(concurrency(name, branch('refactor/x', 302))).toEqual({
        group: older.group,
        cancel: true,
      });
      expect(concurrency(name, branch('refactor/y', 303)).group).not.toBe(older.group);
      const entry = concurrency(name, queue(7, 304));
      expect(entry.cancel).toBe(false);
      expect(entry.group).toContain(queue(7, 0).ref);
      expect(concurrency(name, queue(8, 305)).group).not.toBe(entry.group);
    }
  );

  it.each(automatic)('%s: groups never collide across events or identity kinds', (name) => {
    // Run IDs are unique per run, but may equal a PR number or a branch name.
    // GitHub compares group names case-insensitively.
    const groups = [
      pr(7, 1),
      dispatch(7),
      branch('main', 8),
      branch('8', 2),
      branch('release/8', 3),
      push('refs/tags/8', 4),
      schedule(5),
      queue(7, 6),
    ].map((scenario) => concurrency(name, scenario).group.toLowerCase());
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('isolates PR title/body edits and keeps the required check static', () => {
    const edit = { action: 'edited', changes: { title: { from: 'Old title' } } };
    for (const name of [...policy.ci, ...policy.packaged]) {
      const code = concurrency(name, pr(7, 401));
      const first = concurrency(name, pr(7, 402, edit));
      const second = concurrency(name, pr(7, 403, edit));
      expect(first.cancel, name).toBe(false);
      expect(new Set([code.group, first.group, second.group]).size, name).toBe(3);
    }
    const gate = workflows.get('ci')!.jobs['full-qualification'];
    expect(gate).toMatchObject({ name: 'Full qualification', if: 'always() && !cancelled()' });
  });

  it('keeps base and unknown PR edits isolated: they run their own CI and never cancel', () => {
    for (const changes of [
      { base: { ref: { from: 'release/2.19' } } },
      { title: { from: 'Old title' }, base: { sha: { from: 'b'.repeat(40) } } },
      {},
    ]) {
      const edit = { action: 'edited', changes };
      const code = concurrency('ci', pr(7, 411));
      const first = concurrency('ci', pr(7, 412, edit));
      const second = concurrency('ci', pr(7, 413, edit));
      expect(first.cancel, JSON.stringify(changes)).toBe(false);
      expect(new Set([code.group, first.group, second.group]).size).toBe(3);
    }
  });

  // A title/body edit run may wait for the same-input CI run inside the static
  // required check. It must stay bounded and must never succeed without a
  // deciding step: a gate job whose steps were all skipped would pass.
  it('runs exactly one deciding step in Full qualification and bounds the metadata wait', () => {
    const steps = workflows.get('ci')!.jobs['full-qualification'].steps ?? [];
    const metadata = steps.find(
      (step) => step.name === 'Verify completed current-code qualification after metadata edits'
    );
    const full = steps.find((step) => step.name === 'Require complete current-code qualification');
    expect(metadata?.run).toBe('node scripts/ci/ci-feedback.mts metadata-gate');
    expect(full?.run).toBe('node scripts/ci/ci-feedback.mts gate');
    expect((metadata?.['timeout-minutes'] ?? Infinity) * 60_000).toBeGreaterThan(
      METADATA_GATE.waitMs
    );
    expect(metadata?.['timeout-minutes']).toBeLessThanOrEqual(120);
    const values = ['true', 'false', '', 'unknown'];
    for (const result of ['success', 'failure', 'cancelled', 'skipped'])
      for (const metadataOutput of values)
        for (const fullOutput of values)
          for (const reuse of values) {
            const context = {
              needs: {
                plan: {
                  result,
                  outputs: { metadata: metadataOutput, full: fullOutput, reuse },
                },
              },
            };
            const runs = [metadata!, full!].filter((step) =>
              evaluateWorkflowValue(`\${{ ${step.if} }}`, context)
            );
            expect(runs.length, JSON.stringify(context)).toBe(1);
          }
  });

  it('keeps Pages publication latest-per-ref', () => {
    const older = concurrency('landing', branch('main', 501));
    expect(concurrency('landing', branch('main', 502))).toEqual({
      group: older.group,
      cancel: true,
    });
    expect(concurrency('landing', dispatch(503)).group).toBe(older.group);
  });

  it.each(policy.serialized)('%s: serialized operations never cancel running work', (name) => {
    const triggers = workflows.get(name)!.triggers;
    expect(triggers.every((trigger) => ['workflow_dispatch', 'release'].includes(trigger))).toBe(
      true
    );
    for (const trigger of triggers) {
      const run = trigger === 'release' ? release(601) : dispatch(601);
      expect(concurrency(name, run).cancel).toBe(false);
    }
  });

  it.each(policy.qualification)(
    '%s: retains each security qualification instead of cancelling it',
    (name) => {
      const first = concurrency(name, pr(7, 701));
      expect(concurrency(name, pr(7, 702))).toEqual({ group: first.group, cancel: false });
      expect(concurrency(name, pr(8, 703)).group).not.toBe(first.group);
      expect(concurrency(name, dispatch(704)).cancel).toBe(false);
    }
  );

  it('leaves independent qualification, ReviewRouter and manual or reusable runs without run groups', () => {
    for (const name of policy.unmanaged)
      expect(workflows.get(name)!.concurrency, name).toBeUndefined();
    // A called workflow sees the caller's github context and name, so the same
    // expression would put it in the caller's group and cancel or block the caller.
    for (const [name, workflow] of workflows) {
      if (workflow.triggers.includes('workflow_call'))
        expect(workflow.concurrency, name).toBeUndefined();
    }
  });

  it.each(superseding)('%s: always() job gates stop once the run is cancelled', (name) => {
    for (const [job, { if: condition }] of Object.entries(workflows.get(name)!.jobs)) {
      if (typeof condition === 'string' && condition.includes('always()')) {
        expect(condition, `${name}.${job}`).toContain('!cancelled()');
      }
    }
  });
});
