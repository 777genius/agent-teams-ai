import { describe, expect, it } from 'vitest';

import { parseBackupRunId, parseSha256Digest } from '@features/coordination-backup/contracts';
import { DurableBackupIdentityInventory } from '@features/coordination-backup/main/adapters/output/DurableBackupIdentityInventory';
import { parseDeploymentId } from '@shared/contracts/hosted';

import type { BackupIdentityInventory } from '@features/coordination-backup/contracts';
import type { CaptureBackupIdentityInventoryRequest } from '@features/coordination-backup/core/application';
import type { WorkspaceId } from '@shared/contracts/hosted';

const RUN_ID = parseBackupRunId('backup_identity-inventory-001');
const DEPLOYMENT_ID = parseDeploymentId('deployment_identity-inventory');
const DIGEST = parseSha256Digest('a'.repeat(64));

describe('DurableBackupIdentityInventory', () => {
  it.each(['', 'workspace_not-canonical'])(
    'rejects invalid branded workspace id %j',
    async (id) => {
      const source = {
        captureDurableIdentityInventory: (): Promise<BackupIdentityInventory> =>
          Promise.resolve({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            identities: [
              {
                kind: 'deployment',
                identityId: DEPLOYMENT_ID,
                parentIdentityId: null,
                state: 'active',
                checksum: DIGEST,
                fileEntryId: 'identity/deployment.json',
              },
            ],
            workspaceRegistrations: [
              {
                workspaceId: id as WorkspaceId,
                registrationKey: 'registration-a',
                state: 'registered',
              },
            ],
          }),
      };
      const inventory = new DurableBackupIdentityInventory({
        deploymentId: DEPLOYMENT_ID,
        source,
      });

      await expect(inventory.capture(captureRequest())).rejects.toThrow(
        'hosted-contract-canonical-identifier-invalid'
      );
    }
  );
});

function captureRequest(): CaptureBackupIdentityInventoryRequest {
  const fence = Object.freeze({ generation: 1, admittedRunId: RUN_ID });
  return Object.freeze({
    backupRunId: RUN_ID,
    fence,
    barrier: Object.freeze({
      stateCompatibilityManifest: Object.freeze({
        schemaVersion: 3 as const,
        manifestId: 'manifest-a',
        sha256: DIGEST,
      }),
      acceptedCommandDrain: Object.freeze({
        admittedRunId: RUN_ID,
        fenceGeneration: 1,
        throughCommandCursor: 'application-command-outbox-v1:0',
        durableBarrier: 'coordination-drain-v1.test',
      }),
      participantRecoveryPoints: Object.freeze([]),
      eventCursor: 'coordination-event-cursor',
      eventEpoch: 'epoch-a',
      journalCursors: Object.freeze({}),
    }),
  });
}
