import { randomUUID } from 'node:crypto';

import { readBackupManifestStrict, writeBackupManifestStrictAware } from './teamBackupManifest';

export interface TeamWorkSyncRestorePendingIdentity {
  identityId: string;
  generation: string;
}

/**
 * Existing manifest owns the durable pending record. Call only while the backup
 * owner's identity fence and team mutex are held; this class does not nest locks.
 */
export class TeamWorkSyncRestorePending {
  constructor(
    private readonly ports: {
      getManifestPath(teamName: string): string;
      isShuttingDown(): boolean;
    }
  ) {}

  async begin(teamName: string, identityId: string): Promise<TeamWorkSyncRestorePendingIdentity> {
    const manifestPath = this.ports.getManifestPath(teamName);
    const manifest = await readBackupManifestStrict(manifestPath, teamName);
    if (!manifest || manifest.identityId !== identityId) {
      throw new Error('Restore pending source identity changed');
    }
    if (this.ports.isShuttingDown()) throw new Error('Restore pending owner is shutting down');
    if (manifest.workSyncRestorePending) return { ...manifest.workSyncRestorePending };
    const pending = { identityId, generation: randomUUID() };
    await writeBackupManifestStrictAware(
      manifestPath,
      {
        ...manifest,
        workSyncRestorePending: pending,
      },
      { strict: true, isShuttingDown: () => this.ports.isShuttingDown() }
    );
    return pending;
  }

  async clear(teamName: string, expected: TeamWorkSyncRestorePendingIdentity): Promise<void> {
    const manifestPath = this.ports.getManifestPath(teamName);
    const manifest = await readBackupManifestStrict(manifestPath, teamName);
    const pending = manifest?.workSyncRestorePending;
    if (
      !manifest ||
      manifest.identityId !== expected.identityId ||
      !pending ||
      pending.identityId !== expected.identityId ||
      pending.generation !== expected.generation
    ) {
      throw new Error('Restore pending generation changed');
    }
    // Read the latest manifest under the owner fence; never replay a begin snapshot.
    delete manifest.workSyncRestorePending;
    await writeBackupManifestStrictAware(manifestPath, manifest, {
      strict: true,
      isShuttingDown: () => this.ports.isShuttingDown(),
    });
  }
}
