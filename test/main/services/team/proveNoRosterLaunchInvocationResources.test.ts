import { inspectBootstrapStateForInvocationAbsence } from '@main/services/team/proveNoRosterLaunchInvocationResources';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('bootstrap-state invocation absence evidence', () => {
  let sandbox = '';
  const teamName = 'recovery-team';
  const statePath = () => path.join(sandbox, 'teams', teamName, 'bootstrap-state.json');

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-absence-'));
    setClaudeBasePathOverride(sandbox);
    await fs.mkdir(path.dirname(statePath()), { recursive: true });
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('ignores a valid stale bootstrap from a different dispatch', async () => {
    await fs.writeFile(statePath(), JSON.stringify({ version: 1, launchCommandId: 'old-command' }));

    await expect(inspectBootstrapStateForInvocationAbsence(teamName, 'new-command')).resolves.toBe(
      'ignore'
    );
  });

  it('vetoes absence for matching dispatch evidence', async () => {
    await fs.writeFile(statePath(), JSON.stringify({ version: 1, runId: 'current-command' }));

    await expect(
      inspectBootstrapStateForInvocationAbsence(teamName, 'current-command')
    ).resolves.toBe('veto');
  });

  it('keeps malformed bootstrap evidence conservative', async () => {
    await fs.writeFile(statePath(), '{not-json');

    await expect(
      inspectBootstrapStateForInvocationAbsence(teamName, 'current-command')
    ).resolves.toBe('conservative');
  });
});
