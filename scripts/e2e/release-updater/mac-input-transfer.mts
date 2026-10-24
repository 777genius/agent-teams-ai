import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadPlan } from '../../ci/release/assembly.ts';
import { canonical, digest } from '../../ci/release/contract.ts';
import { prepareMacInputs } from './mac-inputs.mts';
import {
  macInputCommand,
  macInputWorkflows,
  retrieveMacInputArtifact,
} from './mac-input-artifact.mts';

import type { MacInputBundle } from './mac-input-artifact.mts';

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      'operation',
      'plan',
      'plan-sha256',
      'input-digest',
      'tooling-sha',
      'feed-mode',
      'output',
      'artifact-id',
      'artifact-sha256',
    ].map((name) => [name, { type: 'string' as const }])
  ),
  strict: true,
  allowPositionals: false,
});
function required(name: string) {
  const value: unknown = Reflect.get(values, name);
  assert(typeof value === 'string' && value.length > 0, `--${name} required`);
  return value;
}
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, '777genius/agent-teams-ai');
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
const workflowPath =
  process.env.GITHUB_WORKFLOW_REF?.split('@')[0]?.split('/').slice(2).join('/') ?? '';
assert(macInputWorkflows.includes(workflowPath));
const toolingSha = required('tooling-sha');
assert(/^[a-f0-9]{40}$/.test(toolingSha));
assert.equal(process.env.GITHUB_SHA, toolingSha);
assert.equal((await macInputCommand(['rev-parse', 'HEAD'], 'git')).trim(), toolingSha);
const runId = Number(process.env.GITHUB_RUN_ID);
const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
assert(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0);
const runner = await realpath(process.env.RUNNER_TEMP ?? '');
const directory = path.resolve(required('output'));
assert(directory.startsWith(`${runner}/TEST-mac-authenticated-inputs`));
const operation = required('operation');
if (operation === 'retrieve') {
  await retrieveMacInputArtifact(
    {
      toolingSha,
      runId,
      attempt,
      workflowPath,
      artifactId: Number(required('artifact-id')),
      artifactSha256: required('artifact-sha256'),
    },
    directory
  );
} else {
  assert.equal(operation, 'prepare');
  assert.equal(
    process.platform,
    'linux',
    'Draft authentication belongs only to the Ubuntu producer'
  );
  assert.equal(process.env.GITHUB_JOB, 'prepare-mac-inputs');
  const mode = required('feed-mode');
  assert(mode === 'preview' || mode === 'staged');
  const planSha256 = required('plan-sha256');
  const inputDigest = required('input-digest');
  const plan = await loadPlan(required('plan'), planSha256);
  assert.equal(digest(canonical(plan.input)), inputDigest);
  assert.equal(plan.input.toolingSha, toolingSha);
  assert.equal(plan.input.repository, '777genius/agent-teams-ai');
  assert.equal(plan.input.target.tag, 'v2.17.6');
  assert.equal(plan.input.mode, 'carry-mac');
  assert.equal(
    plan.input.macSource?.release.applicationSha,
    '395572f9ff2a261cb28224754883a39d2c3c8827'
  );
  assert.equal(plan.input.macSource?.release.tag, 'v2.17.1');
  await mkdir(directory);
  await writeFile(path.join(directory, 'stage-plan.json'), await readFile(required('plan')), {
    flag: 'wx',
  });
  for (const [source, destination] of [
    ['run.json', 'prepared-run.json'],
    ['artifact.json', 'prepared-artifact.json'],
  ]) {
    assert(source && destination);
    await writeFile(
      path.join(directory, destination),
      await readFile(path.join(path.dirname(required('plan')), source)),
      { flag: 'wx' }
    );
  }
  const platforms = {} as MacInputBundle['platforms'];
  for (const architecture of ['arm64', 'x64'] as const) {
    const root = path.join(directory, architecture);
    await mkdir(root);
    const prepared = await prepareMacInputs(
      plan,
      root,
      mode,
      architecture,
      {},
      { planSha256, inputDigest, toolingSha }
    );
    platforms[architecture] = { source: prepared.source, inputProof: prepared.inputProof };
  }
  const receipt: MacInputBundle = {
    schemaVersion: 1,
    repository: '777genius/agent-teams-ai',
    mode,
    toolingSha,
    planSha256,
    inputDigest,
    runId,
    attempt,
    platforms,
  };
  await writeFile(path.join(directory, 'mac-input-bundle.json'), `${canonical(receipt)}\n`, {
    flag: 'wx',
  });
}
