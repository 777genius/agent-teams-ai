import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearOpenCodeRuntimeLaneStorage,
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeRuntimeLaneIndexPath,
  getOpenCodeRuntimeManifestPath,
  getOpenCodeTeamRuntimeDirectory,
  inspectOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState,
  OpenCodeRuntimeManifestEvidenceReader,
  prepareOpenCodeRuntimeLaneForLaunchGeneration,
  readCommittedOpenCodeBootstrapSessionEvidence,
  readOpenCodeRuntimeLaneIndex,
  recoverStaleOpenCodeRuntimeLaneIndexEntry,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createDefaultRuntimeStoreManifest,
  createRuntimeStoreManifestStore,
  createRuntimeStoreReceiptStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  RuntimeStoreBatchWriter,
} from '../../../../src/main/services/team/opencode/store/RuntimeStoreManifest';

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

  async function writeCommittedSessionStore(input: {
    teamName: string;
    laneId: string;
    sessions: unknown[];
  }) {
    const descriptor = OPENCODE_RUNTIME_STORE_DESCRIPTORS.find(
      (candidate) => candidate.schemaName === 'opencode.sessionStore'
    );
    if (!descriptor) throw new Error('session descriptor missing');
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, input.teamName, input.laneId);
    const runtimeDirectory = path.dirname(manifestPath);
    await fs.mkdir(runtimeDirectory, { recursive: true });
    const writer = new RuntimeStoreBatchWriter(
      runtimeDirectory,
      createRuntimeStoreManifestStore({ filePath: manifestPath, teamName: input.teamName }),
      createRuntimeStoreReceiptStore({
        filePath: path.join(runtimeDirectory, 'opencode-runtime-receipts.json'),
      }),
      {
        clock: () => now,
        batchIdFactory: () => 'batch-1',
        receiptIdFactory: () => 'receipt-1',
      }
    );
    await writer.writeBatch({
      teamName: input.teamName,
      runId: 'runtime-run-1',
      capabilitySnapshotId: null,
      behaviorFingerprint: null,
      reason: 'launch_checkpoint',
      writes: [{ descriptor, data: { sessions: input.sessions } }],
    });
  }

  it('reads only committed OpenCode bootstrap check-in session evidence', async () => {
    const teamName = 'team-committed-session';
    const laneId = 'secondary:opencode:tom';
    await writeCommittedSessionStore({
      teamName,
      laneId,
      sessions: [
        {
          id: 'ses-tom',
          teamName,
          memberName: 'tom',
          runId: 'runtime-run-1',
          laneId,
          providerId: 'opencode',
          observedAt: '2026-04-22T10:00:00.000Z',
          source: 'runtime_bootstrap_checkin',
        },
        {
          id: 'ses-ignored',
          teamName,
          memberName: 'tom',
          runId: 'runtime-run-1',
          laneId,
          source: 'member_briefing',
        },
      ],
    });

    await expect(
      readCommittedOpenCodeBootstrapSessionEvidence({ teamsBasePath: tempDir, teamName, laneId })
    ).resolves.toMatchObject({
      state: 'healthy',
      committed: true,
      sessions: [
        {
          id: 'ses-tom',
          teamName,
          memberName: 'tom',
          laneId,
          runId: 'runtime-run-1',
          source: 'runtime_bootstrap_checkin',
        },
      ],
    });
  });

  it('does not treat an uncommitted session file as OpenCode bootstrap evidence', async () => {
    const teamName = 'team-uncommitted-session';
    const laneId = 'secondary:opencode:tom';
    const sessionPath = getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      fileName: 'opencode-sessions.json',
    });
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-04-22T10:00:00.000Z',
        data: {
          sessions: [
            {
              id: 'ses-tom',
              teamName,
              memberName: 'tom',
              laneId,
              source: 'runtime_bootstrap_checkin',
            },
          ],
        },
      }),
      'utf8'
    );

    const evidence = await readCommittedOpenCodeBootstrapSessionEvidence({
      teamsBasePath: tempDir,
      teamName,
      laneId,
    });

    expect(evidence.committed).toBe(false);
    expect(evidence.state).toBe('uncommitted_write');
    expect(evidence.sessions).toEqual([]);
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

    await expect(
      fs.readFile(getOpenCodeRuntimeLaneIndexPath(tempDir, teamName), 'utf8')
    ).resolves.toContain(`"${laneId}"`);
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

  it('reports missing lane storage when an active lane index entry has no lane dir or state', async () => {
    const teamName = 'team-epsilon';
    const laneId = 'secondary:opencode:alice';

    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      state: 'active',
    });

    await expect(
      inspectOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
      })
    ).resolves.toEqual({
      laneDirectoryExists: false,
      hasStateOnDisk: false,
      hasRuntimeEvidenceOnDisk: false,
      manifestEntryCount: null,
      manifestUpdatedAt: null,
      fileNames: [],
    });

    const result = await recoverStaleOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
    });

    expect(result).toEqual({
      stale: true,
      degraded: true,
      diagnostics: [
        `OpenCode lane ${laneId} is marked active in lanes.json, but no lane state exists on disk.`,
      ],
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          laneId,
          state: 'degraded',
          diagnostics: [
            `OpenCode lane ${laneId} is marked active in lanes.json, but no lane state exists on disk.`,
          ],
        },
      },
    });
  });

  it('degrades an active lane that only has a stale empty runtime manifest', async () => {
    const teamName = 'team-empty-manifest';
    const laneId = 'secondary:opencode:bob';

    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-empty',
      clock: () => new Date('2026-04-22T09:55:00.000Z'),
    });
    await fs.writeFile(
      getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        fileName: 'opencode-prompt-delivery-ledger.json',
      }),
      JSON.stringify({ records: [] }),
      'utf8'
    );

    await expect(
      inspectOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
      })
    ).resolves.toMatchObject({
      laneDirectoryExists: true,
      hasStateOnDisk: true,
      hasRuntimeEvidenceOnDisk: false,
      manifestEntryCount: 0,
      fileNames: ['manifest.json', 'opencode-prompt-delivery-ledger.json'],
    });

    const result = await recoverStaleOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      clock: () => now,
      emptyLaneStaleAfterMs: 150_000,
    });

    expect(result).toEqual({
      stale: true,
      degraded: true,
      diagnostics: [
        `OpenCode lane ${laneId} is marked active in lanes.json, but its runtime manifest has no committed runtime evidence after launch grace.`,
      ],
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          laneId,
          state: 'degraded',
          diagnostics: [
            `OpenCode lane ${laneId} is marked active in lanes.json, but its runtime manifest has no committed runtime evidence after launch grace.`,
          ],
        },
      },
    });
  });

  it('does not degrade a fresh active lane while the empty runtime manifest is still inside launch grace', async () => {
    const teamName = 'team-fresh-empty-manifest';
    const laneId = 'secondary:opencode:bob';

    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-fresh',
      clock: () => new Date('2026-04-22T09:59:00.000Z'),
    });

    const result = await recoverStaleOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      clock: () => now,
      emptyLaneStaleAfterMs: 150_000,
    });

    expect(result).toEqual({
      stale: false,
      degraded: false,
      diagnostics: [],
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
        },
      },
    });
  });

  it('quarantines malformed lanes.json and falls back to an empty index', async () => {
    const teamName = 'team-zeta';
    const runtimeDir = getOpenCodeTeamRuntimeDirectory(tempDir, teamName);
    const filePath = getOpenCodeRuntimeLaneIndexPath(tempDir, teamName);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(
        filePath,
        [
          '{',
          '  "version": 1,',
          '  "updatedAt": "2026-04-22T10:00:00.000Z",',
          '  "lanes": {}',
          '}',
          '}',
        ].join('\n'),
        'utf8'
      );

      await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toEqual({
        version: 1,
        updatedAt: expect.any(String),
        lanes: {},
      });
      await expect(fs.readFile(filePath, 'utf8')).rejects.toThrow();

      const runtimeEntries = await fs.readdir(runtimeDir);
      expect(runtimeEntries.some((entry) => /^lanes\.invalid\.\d+\.json$/.test(entry))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('serializes concurrent lane index upserts without losing sibling lanes', async () => {
    const teamName = 'team-eta';

    await Promise.all([
      upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId: 'secondary:opencode:bob',
        state: 'active',
      }),
      upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId: 'secondary:opencode:jack',
        state: 'active',
      }),
      upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId: 'secondary:opencode:tom',
        state: 'active',
      }),
    ]);

    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:bob': { state: 'active' },
        'secondary:opencode:jack': { state: 'active' },
        'secondary:opencode:tom': { state: 'active' },
      },
    });
  });

  it('preserves a lane runId across later state-only index upserts', async () => {
    const teamName = 'team-lane-owner';
    const laneId = 'secondary:opencode:owner';

    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-owner',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      state: 'stopped',
      diagnostics: ['stop requested'],
    });

    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          laneId,
          runId: 'run-owner',
          state: 'stopped',
        },
      },
    });
  });

  it('fails closed when either durable owner differs before clearing known-run storage', async () => {
    const teamName = 'team-cas-owner';
    const laneId = 'secondary:opencode:cas';
    const markerPath = getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      fileName: 'replacement.marker',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-old',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      clock: () => now,
    });
    await fs.writeFile(markerPath, 'replacement', 'utf8');

    await expect(
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-old',
      })
    ).resolves.toBe('owner_changed');
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('replacement');

    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-old',
      clock: () => now,
    });

    await expect(
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-old',
      })
    ).resolves.toBe('owner_changed');
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('replacement');
  });

  it('resumes manifest-first partial cleanup for a matching durable lane owner', async () => {
    const teamName = 'team-cas-partial-cleanup';
    const laneId = 'secondary:opencode:partial-cleanup';
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId);
    const markerPath = getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      fileName: 'remaining.marker',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-partial',
      state: 'stopped',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-partial',
      clock: () => now,
    });
    await fs.writeFile(markerPath, 'remaining', 'utf8');
    await fs.rm(manifestPath);

    const clear = () =>
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-partial',
      });
    await expect(clear()).resolves.toBe('cleared');
    await expect(clear()).resolves.toBe('cleared');

    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {},
    });
    await expect(fs.stat(path.dirname(manifestPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves replacement storage when the index owner changes after manifest-first deletion', async () => {
    const teamName = 'team-cas-replacement-race';
    const laneId = 'secondary:opencode:replacement-race';
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId);
    const markerPath = getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      fileName: 'replacement.marker',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-old',
      state: 'stopped',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-old',
      clock: () => now,
    });
    await fs.rm(manifestPath);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-replacement',
      state: 'active',
    });
    await fs.writeFile(markerPath, 'replacement', 'utf8');

    await expect(
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-old',
      })
    ).resolves.toBe('owner_changed');

    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('replacement');
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          runId: 'run-replacement',
          state: 'active',
        },
      },
    });
  });

  it('clears a matching durable owner atomically and is idempotent for that owner', async () => {
    const teamName = 'team-cas-idempotent';
    const laneId = 'secondary:opencode:idempotent';
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-same',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-same',
      clock: () => now,
    });

    const clear = () =>
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-same',
      });
    await expect(clear()).resolves.toBe('cleared');
    await expect(clear()).resolves.toBe('cleared');

    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {},
    });
    await expect(
      fs.stat(path.dirname(getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId)))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists lane-scoped activeRunId for runtime evidence after app restart', async () => {
    const teamName = 'team-theta';
    const laneId = 'secondary:opencode:jack';
    const reader = new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempDir });

    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-opencode-jack',
      clock: () => now,
    });

    await expect(reader.read(teamName, laneId)).resolves.toMatchObject({
      activeRunId: 'run-opencode-jack',
      highWatermark: 0,
    });
  });

  it('updates raw legacy runtime manifests without dropping existing capability metadata', async () => {
    const teamName = 'team-iota';
    const laneId = 'secondary:opencode:alice';
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId);
    const legacyManifest = {
      ...createDefaultRuntimeStoreManifest(teamName, '2026-04-22T10:00:00.000Z'),
      activeRunId: 'run-old',
      activeCapabilitySnapshotId: 'cap-existing',
      activeBehaviorFingerprint: 'behavior-existing',
      highWatermark: 5,
    };
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');

    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      clock: () => now,
    });

    await expect(
      new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempDir }).read(teamName, laneId)
    ).resolves.toMatchObject({
      activeRunId: 'run-new',
      capabilitySnapshotId: 'cap-existing',
      highWatermark: 0,
    });
  });

  it('preserves committed manifest highWatermark when persisting activeRunId', async () => {
    const teamName = 'team-kappa';
    const laneId = 'secondary:opencode:bob';
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId);
    const committedManifest = {
      ...createDefaultRuntimeStoreManifest(teamName, '2026-04-22T10:00:00.000Z'),
      activeRunId: 'run-old',
      highWatermark: 5,
      lastCommittedBatchId: 'batch-1',
      entries: [
        {
          schemaName: 'opencode.launchState',
          schemaVersion: 1,
          relativePath: 'launch-state.json',
          contentHash: 'sha256:test',
          fileSize: 12,
          mtimeMs: 123,
          runId: 'run-old',
          capabilitySnapshotId: null,
          behaviorFingerprint: null,
          lastWriteReceiptId: 'receipt-1',
          state: 'healthy',
        },
      ],
    };
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(committedManifest, null, 2)}\n`, 'utf8');

    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      clock: () => now,
    });

    await expect(
      new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempDir }).read(teamName, laneId)
    ).resolves.toMatchObject({
      activeRunId: 'run-new',
      highWatermark: 5,
    });
  });
});

describe('prepareOpenCodeRuntimeLaneForLaunchGeneration', () => {
  let tempDir: string;
  const teamName = 'team-launch-generation';
  const laneId = 'secondary:opencode:bob';
  const now = new Date('2026-05-09T10:00:00.000Z');

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-generation-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeSessionStoreForRun(runId: string): Promise<void> {
    const descriptor = OPENCODE_RUNTIME_STORE_DESCRIPTORS.find(
      (candidate) => candidate.schemaName === 'opencode.sessionStore'
    );
    if (!descriptor) throw new Error('session descriptor missing');
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId);
    const runtimeDirectory = path.dirname(manifestPath);
    await fs.mkdir(runtimeDirectory, { recursive: true });
    const writer = new RuntimeStoreBatchWriter(
      runtimeDirectory,
      createRuntimeStoreManifestStore({
        filePath: manifestPath,
        teamName,
        clock: () => now,
      }),
      createRuntimeStoreReceiptStore({
        filePath: path.join(runtimeDirectory, 'opencode-runtime-receipts.json'),
      }),
      {
        clock: () => now,
        batchIdFactory: () => `batch-${runId}`,
        receiptIdFactory: () => `receipt-${runId}`,
      }
    );
    await writer.writeBatch({
      teamName,
      runId,
      capabilitySnapshotId: null,
      behaviorFingerprint: null,
      reason: 'launch_checkpoint',
      writes: [
        {
          descriptor,
          data: {
            sessions: [
              {
                id: `session-${runId}`,
                teamName,
                memberName: 'bob',
                runId,
                laneId,
                providerId: 'opencode',
                source: 'runtime_bootstrap_checkin',
                observedAt: now.toISOString(),
              },
            ],
          },
        },
      ],
    });
  }

  async function readManifest() {
    return createRuntimeStoreManifestStore({
      filePath: getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId),
      teamName,
    }).read();
  }

  it('creates a fresh active manifest when the lane has no manifest', async () => {
    const result = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      reason: 'test_launch',
      clock: () => now,
    });

    await expect(readManifest()).resolves.toMatchObject({
      activeRunId: 'run-new',
      highWatermark: 0,
      entries: [],
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          laneId,
          runId: 'run-new',
          state: 'active',
        },
      },
    });
    expect(result).toMatchObject({ reset: false, reason: 'fresh_manifest_created' });
  });

  it('reuses a same-generation manifest without clearing runtime evidence', async () => {
    await writeSessionStoreForRun('run-current');
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-current',
      clock: () => now,
    });

    const result = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-current',
      reason: 'test_launch',
      clock: () => now,
    });

    await expect(readManifest()).resolves.toMatchObject({
      activeRunId: 'run-current',
      highWatermark: 1,
      entries: [expect.objectContaining({ runId: 'run-current' })],
    });
    await expect(
      fs.readFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          fileName: 'opencode-sessions.json',
        }),
        'utf8'
      )
    ).resolves.toContain('session-run-current');
    expect(result).toMatchObject({ reset: false, reason: 'same_generation_reused' });
  });

  it('resets runtime evidence when activeRunId belongs to an older run', async () => {
    await writeSessionStoreForRun('run-old');
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-old',
      clock: () => now,
    });

    const result = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      reason: 'test_launch',
      clock: () => now,
    });

    await expect(readManifest()).resolves.toMatchObject({
      activeRunId: 'run-new',
      highWatermark: 0,
      entries: [],
    });
    await expect(
      fs.readFile(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          fileName: 'opencode-sessions.json',
        }),
        'utf8'
      )
    ).rejects.toThrow();
    expect(result).toMatchObject({ reset: true, reason: 'active_run_mismatch' });
  });

  it('resets when manifest entries belong to an older run even if activeRunId was advanced', async () => {
    await writeSessionStoreForRun('run-old');
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      clock: () => now,
    });

    const result = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      reason: 'test_launch',
      clock: () => now,
    });

    await expect(readManifest()).resolves.toMatchObject({
      activeRunId: 'run-new',
      highWatermark: 0,
      entries: [],
    });
    expect(result).toMatchObject({ reset: true, reason: 'stale_manifest_entries' });
  });

  it('resets entries without a run id because they cannot prove the current generation', async () => {
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: now.toISOString(),
          data: {
            schemaVersion: 1,
            teamName,
            activeRunId: 'run-new',
            activeCapabilitySnapshotId: null,
            activeBehaviorFingerprint: null,
            highWatermark: 1,
            lastCommittedBatchId: null,
            lastPreparingBatchId: null,
            entries: [
              {
                schemaName: 'opencode.runtimeDiagnostics',
                schemaVersion: 1,
                relativePath: 'opencode-diagnostics.json',
                contentHash: null,
                fileSize: null,
                mtimeMs: null,
                runId: null,
                capabilitySnapshotId: null,
                behaviorFingerprint: null,
                lastWriteReceiptId: null,
                state: 'healthy',
              },
            ],
            lastRecoveryPlanId: null,
            updatedAt: now.toISOString(),
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const result = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      reason: 'test_launch',
      clock: () => now,
    });

    await expect(readManifest()).resolves.toMatchObject({
      activeRunId: 'run-new',
      highWatermark: 0,
      entries: [],
    });
    expect(result).toMatchObject({ reset: true, reason: 'stale_manifest_entries' });
  });

  it('resets unreadable manifests safely', async () => {
    const manifestPath = getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, '{not-json', 'utf8');

    const result = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-new',
      reason: 'test_launch',
      clock: () => now,
    });

    await expect(readManifest()).resolves.toMatchObject({
      activeRunId: 'run-new',
      highWatermark: 0,
      entries: [],
    });
    expect(result).toMatchObject({ reset: true, reason: 'manifest_unreadable' });
  });

  it('resets degraded or stopped lane index state before launch', async () => {
    await writeSessionStoreForRun('run-current');
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-current',
      clock: () => now,
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      state: 'degraded',
      diagnostics: ['previous launch failed'],
    });

    const result = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-current',
      reason: 'test_launch',
      clock: () => now,
    });

    await expect(readManifest()).resolves.toMatchObject({
      activeRunId: 'run-current',
      highWatermark: 0,
      entries: [],
    });
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
        },
      },
    });
    expect(result).toMatchObject({ reset: true, reason: 'lane_index_terminal' });
  });
});
