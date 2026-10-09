import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkWindowsExecutorIdentity,
  checkWindowsWorkflowContext,
  windowsOriginalToolingSha,
} from './windows-execution-provenance.mts';

const executor = 'b'.repeat(40);
void test('Windows executor preserves original E10 plan authority and authenticates current head', () => {
  assert.deepEqual(
    checkWindowsExecutorIdentity(windowsOriginalToolingSha, executor, executor, executor),
    {
      toolingSha: windowsOriginalToolingSha,
      executionSha: executor,
    }
  );
  assert.doesNotThrow(() => checkWindowsExecutorIdentity(executor, executor, executor, executor));
});
void test('Windows executor rejects relabeled plan, checkout, workflow head and mutable refs', () => {
  for (const [tooling, execution, github, checkout] of [
    ['c'.repeat(40), executor, executor, executor],
    [windowsOriginalToolingSha, executor, windowsOriginalToolingSha, executor],
    [windowsOriginalToolingSha, executor, executor, windowsOriginalToolingSha],
    [windowsOriginalToolingSha, executor, undefined, executor],
    [windowsOriginalToolingSha, 'main', 'main', 'main'],
  ])
    assert.throws(() => checkWindowsExecutorIdentity(tooling!, execution!, github, checkout!));
});
void test('native Windows proof retains actual numeric run attempt and exact workflow job', () => {
  const env = {
    TOOLING_SHA: windowsOriginalToolingSha,
    GITHUB_REPOSITORY: '777genius/agent-teams-ai',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF:
      '777genius/agent-teams-ai/.github/workflows/updater-windows-ota.yml@refs/heads/fix/windows',
    GITHUB_RUN_ID: '113512889176',
    GITHUB_RUN_ATTEMPT: '3',
    GITHUB_JOB: 'windows-ota',
  };
  assert.deepEqual(checkWindowsWorkflowContext(env, windowsOriginalToolingSha), {
    runId: 113512889176,
    attempt: 3,
    job: 'windows-ota',
  });
  for (const [name, value] of Object.entries({
    TOOLING_SHA: executor,
    GITHUB_REPOSITORY: '777genius/unowned',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_WORKFLOW_REF:
      '777genius/agent-teams-ai/.github/workflows/other.yml@refs/heads/fix/windows',
    GITHUB_RUN_ID: '0',
    GITHUB_RUN_ATTEMPT: '1.5',
    GITHUB_JOB: 'unowned-native-job',
  }))
    assert.throws(() =>
      checkWindowsWorkflowContext({ ...env, [name]: value }, windowsOriginalToolingSha)
    );
});
