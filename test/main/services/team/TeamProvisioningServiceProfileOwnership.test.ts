import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/tmux-installer/main', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
}));

import { buildOpenCodeAppProfileScope } from '../../../../src/main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { claimTeamForThisProfile } from '../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import {
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-service-profile-ownership-'));
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'user-data-a'));
});

afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await rm(root, { recursive: true, force: true });
});

async function writeTeam(teamName: string, ownerUserData?: string): Promise<void> {
  await mkdir(path.join(getTeamsBasePath(), teamName), { recursive: true });
  if (ownerUserData) {
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      reason: 'launch',
      profileScope: buildOpenCodeAppProfileScope(ownerUserData, path.join(root, 'claude')),
    });
  }
}

describe('TeamProvisioningService profile ownership', () => {
  it('admits the startup watchdog scan only for teams this app profile manages', async () => {
    await writeTeam('own', path.join(root, 'user-data-a'));
    await writeTeam('other-profile', path.join(root, 'user-data-b'));
    await writeTeam('session-native');
    const service = new TeamProvisioningService();
    const coordinator = (
      service as unknown as {
        openCodePromptDeliveryWatchdogCoordinator: {
          scan(teamName: string): Promise<number>;
          scanContinuity(teamName: string): Promise<number>;
        };
      }
    ).openCodePromptDeliveryWatchdogCoordinator;
    const scan = vi.spyOn(coordinator, 'scan').mockResolvedValue(2);
    const scanContinuity = vi.spyOn(coordinator, 'scanContinuity').mockResolvedValue(0);

    await expect(service.isTeamManagedByThisProfile('own')).resolves.toBe(true);
    await expect(service.isTeamManagedByThisProfile('other-profile')).resolves.toBe(false);
    await expect(service.scanOpenCodePromptDeliveryWatchdog('other-profile')).resolves.toBe(0);
    await expect(service.scanOpenCodePromptDeliveryWatchdog('session-native')).resolves.toBe(0);
    await expect(service.scanOpenCodePromptDeliveryWatchdog('own')).resolves.toBe(2);
    expect(scan.mock.calls).toEqual([['own']]);

    // The continuity pass is gated on a tracked runtime by the coordinator itself.
    await service.scanOpenCodePromptDeliveryWatchdog('other-profile', 'continuity');
    expect(scanContinuity.mock.calls).toEqual([['other-profile']]);
  });
});
