import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { assertSafeTeamName } from './TeamPermanentDeletionTypes';

import type { IdentityMarkerOwnership } from './TeamPermanentDeletionIdentity';
import type { TeamWorkSyncPriorIdentity } from './TeamWorkSyncPriorIdentity';

export type TeamWorkSyncIdentityObservation =
  | { status: 'identified'; identityId: string }
  | { status: 'absent' | 'deleting' | 'unavailable' }
  | { status: 'unidentified'; reason: 'invalid_config' | 'missing_marker' | 'identity_lost' };

export interface TeamWorkSyncIdentityAccessPorts {
  withFence<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  isFenced(teamName: string): Promise<boolean>;
  isRestoreReady?(teamName: string): Promise<boolean>;
  observePriorIdentity(teamName: string): Promise<TeamWorkSyncPriorIdentity>;
  claimMarker(teamName: string, identityId: string): Promise<IdentityMarkerOwnership>;
}

/** Reads and adopts the existing lifecycle marker; never owns a second registry. */
export class TeamWorkSyncIdentityAccess {
  constructor(private readonly ports: TeamWorkSyncIdentityAccessPorts) {}

  readCurrent(teamName: string): Promise<TeamWorkSyncIdentityObservation> {
    assertSafeTeamName(teamName);
    return this.ports.withFence(teamName, () => this.readWithinFence(teamName));
  }

  adoptLegacy(teamName: string): Promise<TeamWorkSyncIdentityObservation> {
    assertSafeTeamName(teamName);
    return this.ports.withFence(teamName, async () => {
      const observed = await this.readWithinFence(teamName);
      if (observed.status !== 'unidentified' || observed.reason !== 'missing_marker') {
        return observed;
      }
      try {
        const prior = await this.ports.observePriorIdentity(teamName);
        if (prior === 'unavailable') return { status: 'unavailable' };
        if (prior === 'known') {
          return { status: 'unidentified', reason: 'identity_lost' };
        }
        const ownership = await this.ports.claimMarker(teamName, randomUUID());
        if (ownership.status === 'unavailable') return { status: 'unavailable' };
        // The claim may lose to another adopter. Only the current source marker
        // is authoritative; never publish our proposed UUID as the result.
        return this.readWithinFence(teamName);
      } catch {
        return { status: 'unavailable' };
      }
    });
  }

  /** Keep this callback short: only an authority commit, never provider/network I/O. */
  withCurrent<T>(
    teamName: string,
    identityId: string,
    operation: () => Promise<T>
  ): Promise<
    { current: true; value: T } | { current: false; identity: TeamWorkSyncIdentityObservation }
  > {
    assertSafeTeamName(teamName);
    return this.ports.withFence(teamName, async () => {
      const identity = await this.readWithinFence(teamName);
      if (identity.status !== 'identified' || identity.identityId !== identityId) {
        return { current: false, identity };
      }
      return { current: true, value: await operation() };
    });
  }

  private async readWithinFence(teamName: string): Promise<TeamWorkSyncIdentityObservation> {
    try {
      if (await this.ports.isFenced(teamName)) return { status: 'deleting' };
      if (this.ports.isRestoreReady && !(await this.ports.isRestoreReady(teamName))) {
        return { status: 'unavailable' };
      }
      const root = join(getTeamsBasePath(), teamName);
      let raw: string;
      try {
        raw = await readFile(join(root, 'config.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unavailable' };
        try {
          await stat(root);
          return { status: 'unidentified', reason: 'invalid_config' };
        } catch (rootError) {
          return {
            status:
              (rootError as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable',
          };
        }
      }
      let config: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { status: 'unidentified', reason: 'invalid_config' };
        }
        config = parsed as Record<string, unknown>;
      } catch {
        return { status: 'unidentified', reason: 'invalid_config' };
      }
      if (typeof config.name !== 'string' || !config.name.trim()) {
        return { status: 'unidentified', reason: 'invalid_config' };
      }
      if (config._backupIdentityId === undefined) {
        return { status: 'unidentified', reason: 'missing_marker' };
      }
      const identityId = config._backupIdentityId;
      return typeof identityId === 'string' &&
        identityId.trim() === identityId &&
        identityId.length > 0
        ? { status: 'identified', identityId }
        : { status: 'unidentified', reason: 'invalid_config' };
    } catch {
      return { status: 'unavailable' };
    }
  }
}
