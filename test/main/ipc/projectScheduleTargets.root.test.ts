import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectScheduleTargets } from '../../../src/main/ipc/teams/projectScheduleTargets';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import {
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';

const roots: string[] = [];

async function useRoot(name: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `sched-root-${name}-`)));
  roots.push(root);
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'app'));
  await fs.mkdir(getTeamsBasePath(), { recursive: true });
  return root;
}

/** A launched per-project team: a logical team and one ready project copy. */
async function writePerProjectTeam(projectPath: string) {
  const teams = getTeamsBasePath();
  const logical = path.join(teams, 'builders');
  const copy = path.join(teams, 'ptc-tok-a');
  await fs.mkdir(logical, { recursive: true });
  await fs.mkdir(copy, { recursive: true });
  await fs.writeFile(
    path.join(logical, 'team.meta.json'),
    JSON.stringify({ version: 1, cwd: projectPath, createdAt: 1, projectContextMode: 'per_project' })
  );
  await fs.writeFile(
    path.join(logical, 'project-contexts.json'),
    JSON.stringify({
      version: 1,
      logicalTeamName: 'builders',
      contexts: [
        {
          id: randomUUID(),
          projectKey: projectPath,
          projectPath,
          executionTeamName: 'ptc-tok-a',
          state: 'ready',
        },
      ],
    })
  );
  await claimTeamForThisProfile({ teamsBasePath: teams, teamName: 'builders', reason: 'create' });
  await claimTeamForThisProfile({ teamsBasePath: teams, teamName: 'ptc-tok-a', reason: 'create' });
}

function makeTargets() {
  const stopped = { isAlive: false, runId: null, progress: null };
  return createProjectScheduleTargets(
    {
      runtime: { getRuntimeState: vi.fn(async () => stopped) } as never,
      provisioningRun: { hasProvisioningRun: vi.fn(() => false) } as never,
    },
    {} as never,
    { launchTeam: vi.fn() }
  );
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('schedule targets after the Claude root changes without a restart', () => {
  it('judges teams by the current root, not by the root at startup', async () => {
    await useRoot('old');
    const targets = makeTargets(); // built while the old root is active, like at app startup

    const newRoot = await useRoot('new');
    const projectPath = path.join(newRoot, 'project-a');
    await fs.mkdir(projectPath);
    await writePerProjectTeam(projectPath);

    // The project copy of the NEW root is a copy: it can not be scheduled directly (which
    // would launch it without the launch gate).
    expect(await targets.admit('ptc-tok-a')).toMatchObject({ allowed: false });
    // The logical team of the new root resolves to its ready copy.
    expect(
      await targets.resolve({ teamName: 'builders', launchConfig: { cwd: projectPath } })
    ).toEqual({ kind: 'project', executionTeamName: 'ptc-tok-a', projectPath });
  });
});
