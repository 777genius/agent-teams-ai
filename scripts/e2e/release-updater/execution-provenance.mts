import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const originalToolingSha = '80ad7936b6d602c89f712e14771911098277ec44';

export function checkExecutorIdentity(
  toolingSha: string,
  executionSha: string,
  githubSha: string | undefined,
  checkoutSha: string
) {
  assert(/^[a-f0-9]{40}$/.test(toolingSha) && /^[a-f0-9]{40}$/.test(executionSha));
  assert.equal(githubSha, executionSha, 'Executor must be the actual workflow head');
  assert.equal(checkoutSha, executionSha, 'Executor must be the actual checkout');
  if (executionSha !== toolingSha)
    assert.equal(toolingSha, originalToolingSha, 'Separate executor requires original T80 plan');
  return { toolingSha, executionSha };
}

export function authenticateExecutor(toolingSha: string, executionSha = toolingSha) {
  return checkExecutorIdentity(
    toolingSha,
    executionSha,
    process.env.GITHUB_SHA,
    execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
  );
}
