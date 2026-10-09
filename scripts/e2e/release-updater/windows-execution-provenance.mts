import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// The prepared P10 data and original native producer stay bound to this E10.
export const windowsOriginalToolingSha = 'a0a8c4d895cfcbe3c790507fe9938b02e4464706';

export function checkWindowsExecutorIdentity(
  toolingSha: string,
  executionSha: string,
  githubSha: string | undefined,
  checkoutSha: string
) {
  assert(/^[a-f0-9]{40}$/u.test(toolingSha) && /^[a-f0-9]{40}$/u.test(executionSha));
  assert.equal(githubSha, executionSha, 'Windows executor must be the actual workflow head');
  assert.equal(checkoutSha, executionSha, 'Windows executor must be the actual checkout');
  if (executionSha !== toolingSha)
    assert.equal(
      toolingSha,
      windowsOriginalToolingSha,
      'Separate Windows executor requires original E10 plan'
    );
  return { toolingSha, executionSha };
}

export function authenticateWindowsExecutor(toolingSha: string, executionSha = toolingSha) {
  const git =
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
  return checkWindowsExecutorIdentity(
    toolingSha,
    executionSha,
    process.env.GITHUB_SHA,
    execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).trim()
  );
}

export function checkWindowsWorkflowContext(env: NodeJS.ProcessEnv, toolingSha: string) {
  assert.equal(env.TOOLING_SHA, toolingSha);
  assert.equal(env.GITHUB_REPOSITORY, '777genius/agent-teams-ai');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(
    env.GITHUB_WORKFLOW_REF?.split('@')[0],
    '777genius/agent-teams-ai/.github/workflows/updater-windows-ota.yml'
  );
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
    assert(/^[1-9]\d*$/u.test(env[name] ?? '') && Number.isSafeInteger(Number(env[name])));
  assert(['windows-predecessor', 'fresh-windows', 'windows-ota'].includes(env.GITHUB_JOB ?? ''));
  return {
    runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    job: env.GITHUB_JOB,
  };
}

export function authenticateWindowsWorkflowExecution(toolingSha: string) {
  return {
    ...checkWindowsWorkflowContext(process.env, toolingSha),
    ...authenticateWindowsExecutor(toolingSha, process.env.EXECUTION_SHA),
  };
}
