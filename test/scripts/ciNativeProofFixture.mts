import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluateWorkflowValue } from '../workflows/runSupersession.mts';
import type { ExpressionContext, ExpressionObject } from '../workflows/runSupersession.mts';
import type { JsonObject } from '../../scripts/ci/ci-feedback-reuse.mts';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobKeys = [
  'retained-opencode-coexistence',
  'codex-login-desktop',
  'stage1-desktop',
  'stage1-process-qualification',
  'stage1-process-diagnostic',
];
const body = (key: string) => {
  const value = workflow.split(`\n  ${key}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
  assert.ok(value, `Missing actual workflow job ${key}`);
  return value;
};
function stepProperty(step: string, property: string): string | undefined {
  const match = new RegExp(`^ {8}${property}: (.+)$`, 'm').exec(step);
  if (!match) return undefined;
  if (match[1] !== '>-' && match[1] !== '|') return match[1];
  const lines = step.slice(match.index + match[0].length + 1).split('\n');
  const end = lines.findIndex((line) => line.trim() !== '' && !line.startsWith('          '));
  return lines
    .slice(0, end < 0 ? lines.length : end)
    .join('\n')
    .trim();
}
function namedSteps(job: string) {
  return job.split(/^ {6}- /m).flatMap((step) => {
    const name = /^name: (.+)$/m.exec(step)?.[1];
    return name ? [{ name, condition: stepProperty(step, 'if') }] : [];
  });
}

/** Build API fixture rows from actual YAML, independently of the production proof model. */
export function nativeProofFixture(
  pr: JsonObject,
  run: JsonObject,
  mode: 'full' | 'draft' | 'metadata'
): { jobs: JsonObject[]; gateSteps: JsonObject[] } {
  const context: ExpressionContext = {
    github: {
      repository: '777genius/agent-teams-ai',
      event_name: 'pull_request',
      event: { pull_request: pr as ExpressionObject },
    },
    inputs: {},
    needs: {
      plan: {
        result: 'success',
        outputs: {
          scope: 'full',
          full: String(mode === 'full'),
          metadata: String(mode === 'metadata'),
          reuse: 'false',
        },
      },
    },
  };
  const selected = (condition: string) => {
    const value = evaluateWorkflowValue(`\${{ ${condition} }}`, context);
    assert.equal(typeof value, 'boolean');
    return value;
  };
  let id = 1000;
  const jobs = jobKeys.flatMap((key) => {
    const source = body(key);
    const name = /^ {4}name: (.+)$/m.exec(source)?.[1];
    const condition =
      /\n {4}if: >-\n([\s\S]*?)\n {4}runs-on:/.exec(source)?.[1] ??
      /^ {4}if: (.+)$/m.exec(source)?.[1];
    assert.ok(name && condition);
    const active = selected(condition);
    const names =
      key === 'stage1-desktop' && active
        ? [...source.matchAll(/^ {12}label: (.+)$/gm)].map((match) =>
            name.replace('${{ matrix.label }}', match[1]!)
          )
        : [name];
    const steps = active
      ? namedSteps(source)
          .filter((step) => !step.condition || step.condition === 'always()')
          .map((step) => ({ name: step.name, status: 'completed', conclusion: 'success' }))
      : [];
    return names.map((value) => ({
      id: id++,
      run_id: run.id,
      run_attempt: run.run_attempt,
      head_sha: run.head_sha,
      name: value,
      status: 'completed',
      conclusion: active ? 'success' : 'skipped',
      completed_at: run.updated_at,
      steps: steps.map((step) => ({ ...step })),
    }));
  });
  const gateSteps = namedSteps(body('full-qualification'))
    .filter((step) => step.name.startsWith('Require selected '))
    .map((step) => {
      assert.ok(step.condition);
      return {
        name: step.name,
        status: 'completed',
        conclusion: selected(step.condition) ? 'success' : 'skipped',
      };
    });
  assert.equal(gateSteps.length, 2);
  return { jobs, gateSteps };
}
