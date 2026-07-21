import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeLaunchPersistencePortsFromService,
  type TeamProvisioningOpenCodeLaunchPersistenceServiceHost,
} from '../TeamProvisioningOpenCodeLaunchPersistencePortsFactory';

import type { OpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

describe('TeamProvisioningOpenCodeLaunchPersistencePortsFactory', () => {
  it('builds OpenCode launch persistence ports from service dependencies', async () => {
    const evidencePorts = {} as OpenCodeRuntimeBootstrapEvidencePorts;
    const snapshot = {
      teamName: 'alpha',
      members: {},
    } as unknown as PersistedTeamLaunchSnapshot;
    const service: TeamProvisioningOpenCodeLaunchPersistenceServiceHost = {
      createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() => evidencePorts),
      writeLaunchStateSnapshot: vi.fn(async () => snapshot),
    };

    const ports = createTeamProvisioningOpenCodeLaunchPersistencePortsFromService(service, {
      nowIso: () => '2026-07-08T00:00:00.000Z',
    });

    expect(ports.createOpenCodeRuntimeBootstrapEvidencePorts()).toBe(evidencePorts);
    expect(ports.nowIso()).toBe('2026-07-08T00:00:00.000Z');
    await expect(
      ports.writeLaunchStateSnapshot('alpha', snapshot, { runId: 'run-alpha' })
    ).resolves.toBe(snapshot);
    expect(service.createOpenCodeRuntimeBootstrapEvidencePorts).toHaveBeenCalledTimes(1);
    expect(service.writeLaunchStateSnapshot).toHaveBeenCalledWith('alpha', snapshot, {
      runId: 'run-alpha',
    });
  });
});
