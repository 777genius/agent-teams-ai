import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/tmux-installer/main', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
}));

import { buildOpenCodeAppProfileScope } from '../../../../src/main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { writeOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
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

/** A team with an active lane and a live process recorded by whoever launched it. */
async function writeTeam(teamName: string, ownerUserData?: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    path.join(teamDir, 'processes.json'),
    `${JSON.stringify([{ id: 'lead-process', pid: process.pid, registeredAt: 'now' }])}\n`
  );
  await writeOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName, {
    version: 1,
    updatedAt: '2026-10-28T10:00:00.000Z',
    lanes: {
      primary: { laneId: 'primary', state: 'active', updatedAt: '2026-10-28T10:00:00.000Z' },
    },
  });
  if (ownerUserData) {
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      reason: 'launch',
      profileScope: buildOpenCodeAppProfileScope(ownerUserData, path.join(root, 'claude')),
    });
  }
}

interface WatchdogInternals {
  openCodePromptDeliveryWatchdogCoordinator: {
    scan(teamName: string): Promise<number>;
    scanActiveLanes(teamName: string, laneIds: string[]): Promise<number>;
  };
  runTracking: { canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean };
}

describe('TeamProvisioningService profile ownership', () => {
  it('admits both watchdog passes only for teams this app profile manages', async () => {
    await writeTeam('own', path.join(root, 'user-data-a'));
    await writeTeam('other-profile', path.join(root, 'user-data-b'));
    await writeTeam('session-native');
    const service = new TeamProvisioningService();
    const internals = service as unknown as WatchdogInternals;
    const coordinator = internals.openCodePromptDeliveryWatchdogCoordinator;
    const scan = vi.spyOn(coordinator, 'scan').mockResolvedValue(2);
    const scanActiveLanes = vi.spyOn(coordinator, 'scanActiveLanes').mockResolvedValue(1);

    // A live recorded pid makes the foreign runtime look reachable to delivery.
    expect(internals.runTracking.canDeliverToOpenCodeRuntimeForTeam('other-profile')).toBe(true);
    await expect(service.isTeamManagedByThisProfile('own')).resolves.toBe(true);
    await expect(service.isTeamManagedByThisProfile('other-profile')).resolves.toBe(false);

    for (const teamName of ['other-profile', 'session-native']) {
      await expect(service.scanOpenCodePromptDeliveryWatchdog(teamName)).resolves.toBe(0);
      await expect(
        service.scanOpenCodePromptDeliveryWatchdog(teamName, 'continuity')
      ).resolves.toBe(0);
    }
    expect(scan).not.toHaveBeenCalled();
    expect(scanActiveLanes).not.toHaveBeenCalled();

    await expect(service.scanOpenCodePromptDeliveryWatchdog('own')).resolves.toBe(2);
    await expect(service.scanOpenCodePromptDeliveryWatchdog('own', 'continuity')).resolves.toBe(1);
    expect(scan.mock.calls).toEqual([['own']]);
    expect(scanActiveLanes).toHaveBeenCalledWith('own', ['primary'], {
      recordlessUnreadRows: 'wake',
    });
  });
});
