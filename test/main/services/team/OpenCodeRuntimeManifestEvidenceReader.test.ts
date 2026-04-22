import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OpenCodeRuntimeManifestEvidenceReader,
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeRuntimeLaneIndexPath,
  getOpenCodeTeamRuntimeDirectory,
  migrateLegacyOpenCodeRuntimeState,
  readOpenCodeRuntimeLaneIndex,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';

describe('OpenCodeRuntimeManifestEvidenceReader migration', () => {
  let tempDir: string;
  let now: Date;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-migration-'));
    now = new Date('2026-04-22T10:00:00.000Z');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('migrates legacy team-scoped OpenCode runtime files into the addressed lane', async () => {
    const teamName = 'team-alpha';
    const laneId = 'secondary:opencode:alice';
    const runtimeDir = getOpenCodeTeamRuntimeDirectory(tempDir, teamName);

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'manifest.json'), '{"highWatermark":7}\n', 'utf8');
    await fs.writeFile(
      path.join(runtimeDir, 'opencode-launch-transaction.json'),
      '{"transactionId":"tx-1"}\n',
      'utf8'
    );

    const result = await migrateLegacyOpenCodeRuntimeState({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      clock: () => now,
    });

    expect(result).toEqual({
      migrated: true,
      degraded: false,
      diagnostics: ['migrated 2 legacy OpenCode runtime files'],
    });

    await expect(fs.readFile(path.join(runtimeDir, 'manifest.json'), 'utf8')).rejects.toThrow();
    await expect(
      fs.readFile(path.join(runtimeDir, 'opencode-launch-transaction.json'), 'utf8')
    ).rejects.toThrow();

    await expect(
      fs.readFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          fileName: 'manifest.json',
        }),
        'utf8'
      )
    ).resolves.toBe('{"highWatermark":7}\n');
    await expect(
      fs.readFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          fileName: 'opencode-launch-transaction.json',
        }),
        'utf8'
      )
    ).resolves.toBe('{"transactionId":"tx-1"}\n');

    await expect(fs.readFile(getOpenCodeRuntimeLaneIndexPath(tempDir, teamName), 'utf8')).resolves.toContain(
      `"${laneId}"`
    );
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          diagnostics: [
            `migrated legacy team-scoped OpenCode runtime state at ${now.toISOString()}`,
          ],
        },
      },
    });
  });

  it('marks ambiguous legacy runtime state as degraded instead of guessing a lane', async () => {
    const teamName = 'team-beta';
    const laneId = 'secondary:opencode:alice';
    const otherLaneId = 'secondary:opencode:bob';
    const runtimeDir = getOpenCodeTeamRuntimeDirectory(tempDir, teamName);

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'manifest.json'), '{"highWatermark":11}\n', 'utf8');
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId: otherLaneId,
      state: 'active',
    });

    const result = await migrateLegacyOpenCodeRuntimeState({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      clock: () => now,
    });

    expect(result.migrated).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.diagnostics).toEqual([
      `Legacy OpenCode runtime state is ambiguous for ${teamName}; existing lanes: ${otherLaneId}`,
    ]);

    await expect(fs.readFile(path.join(runtimeDir, 'manifest.json'), 'utf8')).resolves.toBe(
      '{"highWatermark":11}\n'
    );
    await expect(
      fs.readFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          fileName: 'manifest.json',
        }),
        'utf8'
      )
    ).rejects.toThrow();

    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [otherLaneId]: {
          laneId: otherLaneId,
          state: 'active',
        },
        [laneId]: {
          laneId,
          state: 'degraded',
          diagnostics: [
            `Legacy OpenCode runtime state is ambiguous for ${teamName}; existing lanes: ${otherLaneId}`,
          ],
        },
      },
    });
  });

  it('does not fall back to team-scoped legacy manifest when sibling lane metadata already exists', async () => {
    const teamName = 'team-gamma';
    const laneId = 'secondary:opencode:alice';
    const otherLaneId = 'secondary:opencode:bob';
    const runtimeDir = getOpenCodeTeamRuntimeDirectory(tempDir, teamName);
    const reader = new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempDir });

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(
        runtimeDir,
        'manifest.json'
      ),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-04-22T10:00:00.000Z',
        data: {
          schemaVersion: 1,
          teamName,
          activeRunId: 'legacy-run',
          activeCapabilitySnapshotId: 'cap-1',
          activeBehaviorFingerprint: null,
          highWatermark: 11,
          lastCommittedBatchId: null,
          lastPreparingBatchId: null,
          entries: [],
          lastRecoveryPlanId: null,
          updatedAt: '2026-04-22T10:00:00.000Z',
        },
      }),
      'utf8'
    );
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId: otherLaneId,
      state: 'active',
    });

    await expect(reader.read(teamName, laneId)).resolves.toEqual({
      highWatermark: 0,
      activeRunId: null,
      capabilitySnapshotId: null,
    });
  });

  it('still falls back to team-scoped legacy manifest for safe single-lane backward compatibility', async () => {
    const teamName = 'team-delta';
    const laneId = 'secondary:opencode:alice';
    const runtimeDir = getOpenCodeTeamRuntimeDirectory(tempDir, teamName);
    const reader = new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempDir });

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-04-22T10:00:00.000Z',
        data: {
          schemaVersion: 1,
          teamName,
          activeRunId: 'legacy-run',
          activeCapabilitySnapshotId: 'cap-1',
          activeBehaviorFingerprint: null,
          highWatermark: 11,
          lastCommittedBatchId: null,
          lastPreparingBatchId: null,
          entries: [],
          lastRecoveryPlanId: null,
          updatedAt: '2026-04-22T10:00:00.000Z',
        },
      }),
      'utf8'
    );

    await expect(reader.read(teamName, laneId)).resolves.toEqual({
      highWatermark: 11,
      activeRunId: 'legacy-run',
      capabilitySnapshotId: 'cap-1',
    });
  });
});
