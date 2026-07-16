import { parseTeamId, type TeamId } from '@shared/contracts/hosted/identifiers';

import {
  parseTeamIdentityChecksum,
  TEAM_IDENTITY_FILE_NAME,
  type TeamIdentityChecksum,
} from '../../core/application/ports/TeamIdentityPersistence';

export interface CanonicalIdentityBackupEvidence {
  readonly teamId: TeamId;
  readonly checksum: TeamIdentityChecksum;
  readonly identityFile: typeof TEAM_IDENTITY_FILE_NAME;
}

export interface LegacyBackupIdentityEvidence {
  readonly identityId?: string;
  readonly backupIdentityId?: string;
}

export interface LegacyBackupInventoryInput {
  readonly configReady: boolean;
  readonly discoveredRelativePaths: readonly string[];
  readonly canonicalIdentity: CanonicalIdentityBackupEvidence;
  readonly legacyIdentity?: LegacyBackupIdentityEvidence;
}

export interface LegacyBackupCompatibilityInventory {
  readonly mode: 'async' | 'shutdown_sync';
  readonly classification: 'legacy_unverified';
  readonly recoveryCapability: 'not_verified';
  readonly canonicalIdentity: CanonicalIdentityBackupEvidence;
  readonly legacyIdentity: LegacyBackupIdentityEvidence | null;
  readonly relativePaths: readonly string[];
  readonly canonicalIdentityIncludedRegardlessOfConfigReadiness: true;
}

function normalizeInventoryPaths(paths: readonly string[]): readonly string[] {
  const compatibilityFiles = new Set<string>();
  for (const candidate of paths) {
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.startsWith('/') ||
      /^[A-Za-z]:/.test(candidate) ||
      candidate.includes('\0') ||
      candidate.includes('\\') ||
      candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      continue;
    }
    compatibilityFiles.add(candidate);
  }
  compatibilityFiles.delete(TEAM_IDENTITY_FILE_NAME);
  return [TEAM_IDENTITY_FILE_NAME, ...Array.from(compatibilityFiles).sort()];
}

/**
 * Compatibility-only inventory builder for the existing best-effort backup service. It makes the
 * canonical anchor mandatory in both legacy paths while keeping legacy correlation fields separate.
 * It intentionally never describes the resulting copy as a recovery point.
 */
export class TeamIdentityBackupCompatibility {
  buildAsyncInventory(input: LegacyBackupInventoryInput): LegacyBackupCompatibilityInventory {
    return this.buildInventory('async', input);
  }

  buildShutdownSyncInventory(
    input: LegacyBackupInventoryInput
  ): LegacyBackupCompatibilityInventory {
    return this.buildInventory('shutdown_sync', input);
  }

  private buildInventory(
    mode: LegacyBackupCompatibilityInventory['mode'],
    input: LegacyBackupInventoryInput
  ): LegacyBackupCompatibilityInventory {
    void input.configReady;
    return {
      mode,
      classification: 'legacy_unverified',
      recoveryCapability: 'not_verified',
      canonicalIdentity: {
        teamId: parseTeamId(input.canonicalIdentity.teamId),
        checksum: parseTeamIdentityChecksum(input.canonicalIdentity.checksum),
        identityFile: TEAM_IDENTITY_FILE_NAME,
      },
      legacyIdentity: input.legacyIdentity ? { ...input.legacyIdentity } : null,
      relativePaths: normalizeInventoryPaths(input.discoveredRelativePaths),
      canonicalIdentityIncludedRegardlessOfConfigReadiness: true,
    };
  }
}
