import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { expect, it, vi } from 'vitest';

import type { PreparedOpenCodeRuntimeAdapterLaunch } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeAdapterPreparation';
import type { OpenCodeRuntimeAdapterTeamFlowPorts } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeAdapterTeamFlow';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';
import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: { getInstance: () => ({ addTeamNotification: vi.fn() }) },
}));

function preparedLaunch<TRequest extends TeamCreateRequest | TeamLaunchRequest>(
  launchRequest: TRequest,
  members: TeamCreateRequest['members']
): PreparedOpenCodeRuntimeAdapterLaunch<TRequest> {
  const plannedMembers = members.map((member) => ({ ...member, providerId: 'opencode' as const }));
  return {
    launchRequest,
    effectiveMembers: plannedMembers,
    runtimeLaunchMembers: plannedMembers,
    lanePlan: {
      mode: 'pure_opencode',
      primaryMembers: plannedMembers,
      allMembers: plannedMembers,
      sideLanes: [],
    },
  };
}

async function withPublicOpenCodeCreate(
  run: (input: {
    service: TeamProvisioningService;
    request: TeamCreateRequest;
    root: string;
    launch: ReturnType<typeof vi.fn>;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'opencode-generation-'));
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const owner = new TeamBackupService();
  try {
    await owner.initialize();
    const service = new TeamProvisioningService();
    const adapter = {
      providerId: 'opencode',
      prepare: vi.fn(),
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
    } as unknown as TeamLaunchRuntimeAdapter;
    service.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    service.setDesktopWriterWorkflowLease((name, operation, continuation) =>
      owner.workSyncIdentity.withWriterWorkflowLease(name, operation, continuation)
    );
    const request = {
      teamName: 'test-opencode-team',
      cwd: root,
      providerId: 'opencode',
      members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    } as TeamCreateRequest;
    const prepareFacade = Reflect.get(service, 'prepareFacade') as Pick<
      OpenCodeRuntimeAdapterTeamFlowPorts,
      'prepareOpenCodeRuntimeAdapterLaunch'
    >;
    prepareFacade.prepareOpenCodeRuntimeAdapterLaunch = async ({ request: launchRequest, members }) =>
      preparedLaunch(launchRequest, members);
    const launch = vi.fn(async () => ({ runId: 'synthetic-run' }));
    vi.spyOn(
      service as unknown as { runOpenCodeTeamRuntimeAdapterLaunch: typeof launch },
      'runOpenCodeTeamRuntimeAdapterLaunch'
    ).mockImplementation(launch);
    await run({ service, request, root, launch });
  } finally {
    vi.restoreAllMocks();
    owner.dispose();
    setAppDataBasePath(null);
    setClaudeBasePathOverride(null);
    await rm(root, { recursive: true, force: true });
  }
}

it.each([false, true])(
  'captures a fresh OpenCode generation with a partial tasks directory: %s',
  async (preexistingTasksDirectory) => {
    await withPublicOpenCodeCreate(async ({ service, request, root, launch }) => {
      if (preexistingTasksDirectory) {
        await mkdir(join(root, 'tasks', request.teamName), { recursive: true });
      }
      await expect(service.createTeam(request, () => undefined)).resolves.toEqual({
        runId: 'synthetic-run',
      });
      expect(launch).toHaveBeenCalledOnce();
      const meta = JSON.parse(
        await readFile(join(root, 'teams', request.teamName, 'team.meta.json'), 'utf8')
      ) as { cwd: string };
      expect(meta.cwd).toBe(root);
    });
  }
);

it('rejects a same-name team replacing the captured startup generation', async () => {
  await withPublicOpenCodeCreate(async ({ service, request, root, launch }) => {
    const teamDir = join(root, 'teams', request.teamName);
    const marker = join(teamDir, 'intervening-generation.txt');
    const prepareFacade = Reflect.get(service, 'prepareFacade') as Pick<
      OpenCodeRuntimeAdapterTeamFlowPorts,
      'prepareOpenCodeRuntimeAdapterLaunch'
    >;
    prepareFacade.prepareOpenCodeRuntimeAdapterLaunch = async ({ request: launchRequest, members }) => {
      await rename(teamDir, `${teamDir}-previous`);
      await mkdir(teamDir);
      await writeFile(marker, 'intervening team');
      return preparedLaunch(launchRequest, members);
    };
    await expect(service.createTeam(request, () => undefined)).rejects.toThrow(
      `operator_required: provisioning run writer authority expired: ${request.teamName}`
    );
    expect(launch).not.toHaveBeenCalled();
    await expect(readFile(marker, 'utf8')).resolves.toBe('intervening team');
  });
});
