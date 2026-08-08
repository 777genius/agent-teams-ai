import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeDeliveryJournalStore } from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryJournal';
import {
  clearOpenCodeRuntimeLaneStorage,
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeRuntimeLaneIndexPath,
  getOpenCodeRuntimeLaneLifecycleLockTargetPath,
  getOpenCodeRuntimeManifestPath,
  getOpenCodeTeamRuntimeDirectory,
  getOpenCodeTeamRuntimeLaneDirectory,
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
import { createRuntimeRunTombstoneStore } from '../../../../src/main/services/team/opencode/store/RuntimeRunTombstoneStore';
import {
  createDefaultRuntimeStoreManifest,
  createRuntimeStoreManifestStore,
  createRuntimeStoreReceiptStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  RuntimeStoreBatchWriter,
} from '../../../../src/main/services/team/opencode/store/RuntimeStoreManifest';

const execFileAsync = promisify(execFile);

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

  it('refuses a substituted lane-directory symlink without deleting an external sentinel', async () => {
    const teamName = 'team-symlink-substitution';
    const laneId = 'secondary:opencode:symlink';
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-external-sentinel-'));
    const externalLaneDirectory = path.join(externalRoot, 'lane');
    const externalSentinelPath = path.join(externalLaneDirectory, 'external-sentinel.txt');
    const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
    try {
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-symlink',
        state: 'active',
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-symlink',
        clock: () => now,
      });
      await fs.writeFile(path.join(laneDirectory, 'transient.json'), 'transient', 'utf8');
      await fs.rename(laneDirectory, externalLaneDirectory);
      await fs.writeFile(externalSentinelPath, 'do-not-delete', 'utf8');
      await fs.writeFile(
        path.join(externalLaneDirectory, 'manifest.json'),
        '{external-invalid-json',
        'utf8'
      );
      await fs.symlink(
        externalLaneDirectory,
        laneDirectory,
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      await expect(
        clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          expectedRunId: 'run-symlink',
        })
      ).rejects.toThrow(`Durable directory identity changed during cleanup: ${laneDirectory}`);

      await expect(fs.readFile(externalSentinelPath, 'utf8')).resolves.toBe('do-not-delete');
      await expect(
        fs.readFile(path.join(externalLaneDirectory, 'manifest.json'), 'utf8')
      ).resolves.toBe('{external-invalid-json');
      await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
        lanes: {
          [laneId]: {
            runId: 'run-symlink',
            state: 'active',
          },
        },
      });
    } finally {
      await fs.rm(externalRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'refuses a symlinked lane ancestor without mutating external runtime storage',
    async () => {
      const teamName = 'team-symlinked-lane-ancestor';
      const laneId = 'secondary:opencode:symlinked-ancestor';
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const lanesDirectory = path.dirname(laneDirectory);
      const externalRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'opencode-external-lanes-ancestor-')
      );
      const externalLanesDirectory = path.join(externalRoot, 'lanes');
      const externalSentinelPath = path.join(
        externalLanesDirectory,
        path.basename(laneDirectory),
        'external-sentinel.txt'
      );
      try {
        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          runId: 'run-symlinked-ancestor',
          state: 'active',
        });
        await setOpenCodeRuntimeActiveRunManifest({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          runId: 'run-symlinked-ancestor',
          clock: () => now,
        });
        await fs.writeFile(path.join(laneDirectory, 'transient.json'), 'transient', 'utf8');
        await fs.rename(lanesDirectory, externalLanesDirectory);
        await fs.writeFile(externalSentinelPath, 'do-not-delete', 'utf8');
        await fs.symlink(externalLanesDirectory, lanesDirectory, 'dir');

        await expect(
          clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            expectedRunId: 'run-symlinked-ancestor',
          })
        ).rejects.toThrow('Durable directory identity changed during cleanup');

        await expect(fs.readFile(externalSentinelPath, 'utf8')).resolves.toBe('do-not-delete');
        await expect(
          fs.readFile(
            path.join(externalLanesDirectory, path.basename(laneDirectory), 'transient.json'),
            'utf8'
          )
        ).resolves.toBe('transient');
        await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
          lanes: {
            [laneId]: {
              runId: 'run-symlinked-ancestor',
              state: 'active',
            },
          },
        });
      } finally {
        await fs.rm(externalRoot, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'keeps a replaced lane ancestor outside an in-progress cleanup',
    async () => {
      const teamName = 'team-replaced-lane-ancestor';
      const laneId = 'secondary:opencode:replaced-ancestor';
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const lanesDirectory = path.dirname(laneDirectory);
      const ownedLanesDirectory = `${lanesDirectory}.owned`;
      const externalRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'opencode-replaced-lanes-ancestor-')
      );
      const replacementLanesDirectory = path.join(externalRoot, 'lanes');
      const replacementLaneDirectory = path.join(
        replacementLanesDirectory,
        path.basename(laneDirectory)
      );
      const replacementSentinelPath = path.join(replacementLaneDirectory, 'external-sentinel.txt');
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-replaced-ancestor',
        state: 'active',
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-replaced-ancestor',
        clock: () => now,
      });
      await fs.writeFile(path.join(laneDirectory, 'transient.json'), 'transient', 'utf8');
      await fs.mkdir(replacementLaneDirectory, { recursive: true });
      await fs.writeFile(replacementSentinelPath, 'do-not-delete', 'utf8');

      const originalRename = fs.rename.bind(fs);
      const originalUnlink = fs.unlink.bind(fs);
      let replaced = false;
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        if (!replaced && target.toString().startsWith('/proc/self/fd/')) {
          await originalRename(lanesDirectory, ownedLanesDirectory);
          await originalRename(replacementLanesDirectory, lanesDirectory);
          replaced = true;
        }
        return originalUnlink(target);
      });

      try {
        await expect(
          clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            expectedRunId: 'run-replaced-ancestor',
          })
        ).resolves.toBe('cleared');

        expect(replaced).toBe(true);
        await expect(
          fs.readFile(
            path.join(lanesDirectory, path.basename(laneDirectory), 'external-sentinel.txt'),
            'utf8'
          )
        ).resolves.toBe('do-not-delete');
        await expect(
          fs.readdir(path.join(ownedLanesDirectory, path.basename(laneDirectory)))
        ).resolves.toEqual([]);
        await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
          lanes: {},
        });
      } finally {
        unlinkSpy.mockRestore();
        await fs.rm(externalRoot, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'fails closed before mutation when a retained artifact is a symlink',
    async () => {
      const teamName = 'team-retained-symlink';
      const laneId = 'secondary:opencode:retained-symlink';
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const externalRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'opencode-retained-symlink-sentinel-')
      );
      const externalSentinelPath = path.join(externalRoot, 'external-sentinel.json');
      const transientPath = path.join(laneDirectory, 'transient.json');
      try {
        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          runId: 'run-retained-symlink',
          state: 'active',
        });
        await setOpenCodeRuntimeActiveRunManifest({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          runId: 'run-retained-symlink',
          clock: () => now,
        });
        await fs.writeFile(externalSentinelPath, 'external-content', 'utf8');
        await fs.symlink(
          externalSentinelPath,
          path.join(laneDirectory, 'opencode-delivery-journal.json')
        );
        await fs.writeFile(transientPath, 'transient', 'utf8');

        await expect(
          clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            expectedRunId: 'run-retained-symlink',
          })
        ).rejects.toThrow('Retained directory entry is not a regular file');

        await expect(fs.readFile(externalSentinelPath, 'utf8')).resolves.toBe('external-content');
        await expect(fs.readFile(transientPath, 'utf8')).resolves.toBe('transient');
        await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
          lanes: {
            [laneId]: {
              runId: 'run-retained-symlink',
              state: 'active',
            },
          },
        });
      } finally {
        await fs.rm(externalRoot, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'rejects a retained FIFO without opening it in blocking mode or deleting descendants',
    async () => {
      const teamName = 'team-retained-fifo';
      const laneId = 'secondary:opencode:retained-fifo';
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const retainedFifoPath = path.join(laneDirectory, 'opencode-run-tombstones.json');
      const transientPath = path.join(laneDirectory, 'transient.json');
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-retained-fifo',
        state: 'active',
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-retained-fifo',
        clock: () => now,
      });
      await execFileAsync('/usr/bin/mkfifo', [retainedFifoPath], { timeout: 1_000 });
      await fs.writeFile(transientPath, 'transient', 'utf8');

      await expect(
        clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          expectedRunId: 'run-retained-fifo',
        })
      ).rejects.toThrow('Retained directory entry is not a regular file');

      expect((await fs.lstat(retainedFifoPath)).isFIFO()).toBe(true);
      await expect(fs.readFile(transientPath, 'utf8')).resolves.toBe('transient');
      await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
        lanes: {
          [laneId]: {
            runId: 'run-retained-fifo',
            state: 'active',
          },
        },
      });
    }
  );

  it('uses a matching manifest owner to clear a legacy lane index entry without runId', async () => {
    const teamName = 'team-cas-legacy-index';
    const laneId = 'secondary:opencode:legacy-index';
    const markerPath = getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      fileName: 'legacy.marker',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      state: 'stopped',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-legacy',
      clock: () => now,
    });
    await fs.writeFile(markerPath, 'legacy', 'utf8');

    await expect(
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-legacy',
      })
    ).resolves.toBe('cleared');

    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {},
    });
    await expect(fs.readdir(path.dirname(markerPath))).resolves.toEqual([]);
  });

  it('preserves a legacy lane index entry when its manifest owner mismatches or is absent', async () => {
    const teamName = 'team-cas-legacy-owner-unknown';
    const laneId = 'secondary:opencode:legacy-owner-unknown';
    const markerPath = getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      fileName: 'unknown-owner.marker',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      state: 'stopped',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-replacement',
      clock: () => now,
    });
    await fs.writeFile(markerPath, 'unknown-owner', 'utf8');

    const clear = () =>
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-legacy',
      });
    await expect(clear()).resolves.toBe('owner_changed');
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('unknown-owner');

    await fs.rm(getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId));
    await expect(clear()).resolves.toBe('owner_changed');

    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('unknown-owner');
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          runId: undefined,
          state: 'stopped',
        },
      },
    });
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
    await expect(fs.readdir(path.dirname(manifestPath))).resolves.toEqual([]);
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

  it('retains durable lane journals while atomically removing per-run evidence', async () => {
    const teamName = 'team-durable-lane-artifacts';
    const laneId = 'secondary:opencode:durable-artifacts';
    const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
    const deliveryJournalPath = path.join(laneDirectory, 'opencode-delivery-journal.json');
    const runTombstonesPath = path.join(laneDirectory, 'opencode-run-tombstones.json');
    const transientPath = path.join(laneDirectory, 'transient-run-evidence.json');
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-durable',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-durable',
      clock: () => now,
    });
    await fs.writeFile(deliveryJournalPath, 'delivery-journal', 'utf8');
    await fs.writeFile(runTombstonesPath, 'run-tombstones', 'utf8');
    await fs.writeFile(transientPath, 'transient', 'utf8');

    const clear = () =>
      clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        expectedRunId: 'run-durable',
      });
    await expect(clear()).resolves.toBe('cleared');
    await expect(clear()).resolves.toBe('cleared');

    await expect(fs.readFile(deliveryJournalPath, 'utf8')).resolves.toBe('delivery-journal');
    await expect(fs.readFile(runTombstonesPath, 'utf8')).resolves.toBe('run-tombstones');
    await expect(fs.stat(transientPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {},
    });
  });

  it('fails closed before mutation when identity-stable child operations are unsupported', async () => {
    const teamName = 'team-unsupported-cleanup';
    const laneId = 'secondary:opencode:unsupported-cleanup';
    const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
    const retainedFiles = ['opencode-delivery-journal.json', 'opencode-run-tombstones.json'];
    const transientPath = path.join(laneDirectory, 'transient.json');
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-unsupported',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-unsupported',
      clock: () => now,
    });
    await Promise.all([
      ...retainedFiles.map((fileName) =>
        fs.writeFile(path.join(laneDirectory, fileName), `retained-${fileName}`, 'utf8')
      ),
      fs.writeFile(transientPath, 'transient', 'utf8'),
    ]);

    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      await expect(
        clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          expectedRunId: 'run-unsupported',
        })
      ).rejects.toThrow('Identity-stable directory child operations are unsupported on darwin');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }

    expect((await fs.stat(laneDirectory)).isDirectory()).toBe(true);
    await expect(fs.readFile(transientPath, 'utf8')).resolves.toBe('transient');
    await expect(
      Promise.all(
        retainedFiles.map((fileName) => fs.readFile(path.join(laneDirectory, fileName), 'utf8'))
      )
    ).resolves.toEqual(retainedFiles.map((fileName) => `retained-${fileName}`));
    await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
      lanes: {
        [laneId]: {
          runId: 'run-unsupported',
          state: 'active',
        },
      },
    });
    await expect(
      new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: tempDir }).read(teamName, laneId)
    ).resolves.toMatchObject({ activeRunId: 'run-unsupported' });
  });

  it.skipIf(process.platform !== 'linux')(
    'repeats cleanup without detached quarantine growth',
    async () => {
      const teamName = 'team-bounded-cleanup';
      const laneId = 'secondary:opencode:bounded-cleanup';
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const retainedFiles = ['opencode-delivery-journal.json', 'opencode-run-tombstones.json'];

      for (let generation = 0; generation < 5; generation += 1) {
        const runId = `run-bounded-${generation}`;
        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          runId,
          state: 'active',
        });
        await setOpenCodeRuntimeActiveRunManifest({
          teamsBasePath: tempDir,
          teamName,
          laneId,
          runId,
          clock: () => now,
        });
        if (generation === 0) {
          await Promise.all(
            retainedFiles.map((fileName) =>
              fs.writeFile(path.join(laneDirectory, fileName), `retained-${fileName}`, 'utf8')
            )
          );
        }
        await fs.writeFile(
          path.join(laneDirectory, `transient-${generation}.json`),
          'transient',
          'utf8'
        );

        await expect(
          clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            expectedRunId: runId,
          })
        ).resolves.toBe('cleared');
      }

      const laneParentEntries = await fs.readdir(path.dirname(laneDirectory), {
        withFileTypes: true,
      });
      expect(
        laneParentEntries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      ).toEqual([path.basename(laneDirectory)]);
      expect(laneParentEntries.filter((entry) => entry.name.includes('.cleaning.'))).toHaveLength(
        0
      );
      expect((await fs.readdir(laneDirectory)).sort()).toEqual(retainedFiles);
      await expect(
        Promise.all(
          retainedFiles.map((fileName) => fs.readFile(path.join(laneDirectory, fileName), 'utf8'))
        )
      ).resolves.toEqual(retainedFiles.map((fileName) => `retained-${fileName}`));
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'keeps a rename-to-open substitution replacement outside descriptor-backed cleanup',
    async () => {
      const teamName = 'team-rename-open-substitution';
      const laneId = 'secondary:opencode:rename-open-substitution';
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const ownedDirectory = `${laneDirectory}.owned`;
      const externalRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'opencode-runtime-external-sentinel-')
      );
      const externalLaneDirectory = path.join(externalRoot, 'lane');
      let substitutedLaneDirectory = externalLaneDirectory;
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-rename-open-substitution',
        state: 'active',
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-rename-open-substitution',
        clock: () => now,
      });
      await fs.writeFile(path.join(laneDirectory, 'transient.json'), 'owned-transient', 'utf8');
      await fs.mkdir(externalLaneDirectory);
      await fs.writeFile(
        path.join(externalLaneDirectory, 'external-sentinel.txt'),
        'do-not-delete',
        'utf8'
      );

      const originalRename = fs.rename.bind(fs);
      const originalUnlink = fs.unlink.bind(fs);
      let legacySubstituted = false;
      let descriptorSubstituted = false;
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        await originalRename(source, destination);
        const destinationPath = destination.toString();
        if (
          !legacySubstituted &&
          source.toString() === laneDirectory &&
          destinationPath.includes('.cleaning.')
        ) {
          await originalRename(destination, `${destinationPath}.owned`);
          await originalRename(externalLaneDirectory, destination);
          substitutedLaneDirectory = destinationPath;
          legacySubstituted = true;
        }
      });
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        if (
          !legacySubstituted &&
          !descriptorSubstituted &&
          target.toString().startsWith('/proc/self/fd/')
        ) {
          await originalRename(laneDirectory, ownedDirectory);
          await originalRename(externalLaneDirectory, laneDirectory);
          substitutedLaneDirectory = laneDirectory;
          descriptorSubstituted = true;
        }
        return originalUnlink(target);
      });

      try {
        await expect(
          clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            expectedRunId: 'run-rename-open-substitution',
          })
        ).resolves.toBe('cleared');

        expect(legacySubstituted).toBe(false);
        expect(descriptorSubstituted).toBe(true);
        await expect(
          fs.readFile(path.join(substitutedLaneDirectory, 'external-sentinel.txt'), 'utf8')
        ).resolves.toBe('do-not-delete');
        await expect(fs.readdir(ownedDirectory)).resolves.toEqual([]);
        await expect(readOpenCodeRuntimeLaneIndex(tempDir, teamName)).resolves.toMatchObject({
          lanes: {},
        });
      } finally {
        unlinkSpy.mockRestore();
        renameSpy.mockRestore();
        await fs.rm(externalRoot, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'does not publish retained files into a mkdir-to-open substitution',
    async () => {
      const teamName = 'team-mkdir-open-substitution';
      const laneId = 'secondary:opencode:mkdir-open-substitution';
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const externalRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'opencode-runtime-publication-sentinel-')
      );
      const externalLaneDirectory = path.join(externalRoot, 'lane');
      let substitutedLaneDirectory = externalLaneDirectory;
      const retainedFiles = ['opencode-delivery-journal.json', 'opencode-run-tombstones.json'];
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-mkdir-open-substitution',
        state: 'active',
      });
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-mkdir-open-substitution',
        clock: () => now,
      });
      await Promise.all([
        ...retainedFiles.map((fileName) =>
          fs.writeFile(path.join(laneDirectory, fileName), `owned-${fileName}`, 'utf8')
        ),
        fs.writeFile(path.join(laneDirectory, 'transient.json'), 'owned-transient', 'utf8'),
      ]);
      await fs.mkdir(externalLaneDirectory);
      await fs.writeFile(
        path.join(externalLaneDirectory, 'external-sentinel.txt'),
        'do-not-publish-here',
        'utf8'
      );

      const originalRename = fs.rename.bind(fs);
      const originalMkdir = fs.mkdir.bind(fs);
      let substituted = false;
      const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
        const result = await originalMkdir(target, options);
        if (!substituted && target.toString() === laneDirectory) {
          const rejectedPublicationDirectory = `${laneDirectory}.rejected-publication`;
          await originalRename(laneDirectory, rejectedPublicationDirectory);
          await originalRename(externalLaneDirectory, laneDirectory);
          substitutedLaneDirectory = laneDirectory;
          substituted = true;
        }
        return result;
      });

      try {
        await expect(
          clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            expectedRunId: 'run-mkdir-open-substitution',
          })
        ).resolves.toBe('cleared');

        expect(substituted).toBe(false);
        await expect(fs.readdir(substitutedLaneDirectory)).resolves.toEqual([
          'external-sentinel.txt',
        ]);
        await expect(
          Promise.all(
            retainedFiles.map((fileName) => fs.readFile(path.join(laneDirectory, fileName), 'utf8'))
          )
        ).resolves.toEqual(retainedFiles.map((fileName) => `owned-${fileName}`));
      } finally {
        mkdirSpy.mockRestore();
        await fs.rm(externalRoot, { recursive: true, force: true });
      }
    }
  );

  it('keeps journal and tombstone access pending during descriptor-backed cleanup', async () => {
    const teamName = 'team-descriptor-cleanup-lock';
    const laneId = 'secondary:opencode:descriptor-cleanup-lock';
    const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
    const accessLockTargetPath = getOpenCodeRuntimeLaneLifecycleLockTargetPath(
      tempDir,
      teamName,
      laneId
    );
    let nextTombstoneId = 1;
    const journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(laneDirectory, 'opencode-delivery-journal.json'),
      accessLockTargetPath,
    });
    const tombstones = createRuntimeRunTombstoneStore({
      filePath: path.join(laneDirectory, 'opencode-run-tombstones.json'),
      accessLockTargetPath,
      idFactory: () => `tombstone-${nextTombstoneId++}`,
      clock: () => now,
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-detached',
      state: 'active',
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      runId: 'run-detached',
      clock: () => now,
    });
    await journal.begin({
      idempotencyKey: 'delivery-before-cleanup',
      payloadHash: 'sha256:delivery-before-cleanup',
      runId: 'run-detached',
      teamName,
      fromMemberName: 'Builder',
      providerId: 'opencode',
      runtimeSessionId: 'session-detached',
      destination: { kind: 'member_inbox', teamName, memberName: 'Reviewer' },
      destinationMessageId: 'message-before-cleanup',
      now: now.toISOString(),
    });
    await tombstones.add({
      teamName,
      runId: 'run-before-cleanup',
      reason: 'run_replaced',
    });

    const originalUnlink = fs.unlink.bind(fs);
    let signalCleanupMutation!: () => void;
    let releaseCleanupMutation!: () => void;
    const cleanupMutation = new Promise<void>((resolve) => {
      signalCleanupMutation = resolve;
    });
    const cleanupMutationRelease = new Promise<void>((resolve) => {
      releaseCleanupMutation = resolve;
    });
    let mutationPaused = false;
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (!mutationPaused && target.toString().startsWith('/proc/self/fd/')) {
        mutationPaused = true;
        signalCleanupMutation();
        await cleanupMutationRelease;
      }
      return originalUnlink(target);
    });
    const readFileSpy = vi.spyOn(fs, 'readFile');

    const cleanup = clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: tempDir,
      teamName,
      laneId,
      expectedRunId: 'run-detached',
    });
    try {
      await cleanupMutation;
      readFileSpy.mockClear();

      let journalReadSettled = false;
      let journalWriteSettled = false;
      let tombstoneReadSettled = false;
      let tombstoneWriteSettled = false;
      const journalRead = journal.list().finally(() => {
        journalReadSettled = true;
      });
      const journalWrite = journal
        .begin({
          idempotencyKey: 'delivery-after-cleanup',
          payloadHash: 'sha256:delivery-after-cleanup',
          runId: 'run-after-cleanup',
          teamName,
          fromMemberName: 'Builder',
          providerId: 'opencode',
          runtimeSessionId: 'session-after-cleanup',
          destination: { kind: 'member_inbox', teamName, memberName: 'Reviewer' },
          destinationMessageId: 'message-after-cleanup',
          now: now.toISOString(),
        })
        .finally(() => {
          journalWriteSettled = true;
        });
      const tombstoneRead = tombstones.list(teamName).finally(() => {
        tombstoneReadSettled = true;
      });
      const tombstoneWrite = tombstones
        .add({
          teamName,
          runId: 'run-after-cleanup',
          reason: 'run_replaced',
        })
        .finally(() => {
          tombstoneWriteSettled = true;
        });

      expect(journalReadSettled).toBe(false);
      expect(journalWriteSettled).toBe(false);
      expect(tombstoneReadSettled).toBe(false);
      expect(tombstoneWriteSettled).toBe(false);
      expect(readFileSpy).not.toHaveBeenCalled();

      releaseCleanupMutation();
      await expect(cleanup).resolves.toBe('cleared');
      await expect(journalRead).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ idempotencyKey: 'delivery-before-cleanup' }),
        ])
      );
      await expect(journalWrite).resolves.toMatchObject({
        record: { idempotencyKey: 'delivery-after-cleanup' },
      });
      await expect(tombstoneRead).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: 'run-before-cleanup' })])
      );
      await expect(tombstoneWrite).resolves.toMatchObject({
        runId: 'run-after-cleanup',
      });
      await expect(journal.list()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ idempotencyKey: 'delivery-before-cleanup' }),
          expect.objectContaining({ idempotencyKey: 'delivery-after-cleanup' }),
        ])
      );
      await expect(tombstones.list(teamName)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-before-cleanup' }),
          expect.objectContaining({ runId: 'run-after-cleanup' }),
        ])
      );
    } finally {
      releaseCleanupMutation();
      readFileSpy.mockRestore();
      unlinkSpy.mockRestore();
      await cleanup.catch(() => undefined);
    }
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
      fs.readdir(path.dirname(getOpenCodeRuntimeManifestPath(tempDir, teamName, laneId)))
    ).resolves.toEqual([]);
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

  it.skipIf(process.platform !== 'linux')(
    'keeps a replacement lanes tree outside nested launch cleanup',
    async () => {
      await writeSessionStoreForRun('run-old');
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-old',
        clock: () => now,
      });
      const laneDirectory = getOpenCodeTeamRuntimeLaneDirectory(tempDir, teamName, laneId);
      const lanesDirectory = path.dirname(laneDirectory);
      const admittedLanesDirectory = `${lanesDirectory}.admitted`;
      const externalRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'opencode-launch-lanes-replacement-')
      );
      const replacementLanesDirectory = path.join(externalRoot, 'lanes');
      const replacementLaneDirectory = path.join(
        replacementLanesDirectory,
        encodeURIComponent(laneId)
      );
      const replacementSentinelPath = path.join(replacementLaneDirectory, 'external-sentinel.txt');
      await fs.mkdir(replacementLaneDirectory, { recursive: true });
      await fs.writeFile(replacementSentinelPath, 'do-not-delete', 'utf8');

      const originalStat = fs.stat.bind(fs);
      let substituted = false;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
        const result = await originalStat(target);
        if (
          !substituted &&
          target.toString().endsWith(`/${encodeURIComponent(laneId)}/manifest.json`)
        ) {
          await fs.rename(lanesDirectory, admittedLanesDirectory);
          await fs.rename(replacementLanesDirectory, lanesDirectory);
          substituted = true;
        }
        return result;
      });

      try {
        await expect(
          prepareOpenCodeRuntimeLaneForLaunchGeneration({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            runId: 'run-new',
            reason: 'test_lanes_replacement',
            clock: () => now,
          })
        ).resolves.toMatchObject({ reset: true, reason: 'active_run_mismatch' });

        expect(substituted).toBe(true);
        await expect(
          fs.readFile(
            path.join(lanesDirectory, encodeURIComponent(laneId), 'external-sentinel.txt'),
            'utf8'
          )
        ).resolves.toBe('do-not-delete');
        await expect(
          fs.readdir(path.join(lanesDirectory, encodeURIComponent(laneId)))
        ).resolves.toEqual(['external-sentinel.txt']);
        const admittedManifest = JSON.parse(
          await fs.readFile(
            path.join(admittedLanesDirectory, encodeURIComponent(laneId), 'manifest.json'),
            'utf8'
          )
        ) as { data: { activeRunId: string | null } };
        expect(admittedManifest.data.activeRunId).toBe('run-new');
      } finally {
        statSpy.mockRestore();
        await fs.rm(externalRoot, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'keeps final launch index and manifest publication on admitted descriptors',
    async () => {
      await writeSessionStoreForRun('run-old');
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: tempDir,
        teamName,
        laneId,
        runId: 'run-old',
        clock: () => now,
      });
      const runtimeDirectory = getOpenCodeTeamRuntimeDirectory(tempDir, teamName);
      const admittedRuntimeDirectory = `${runtimeDirectory}.admitted`;
      const externalRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'opencode-launch-publication-replacement-')
      );
      const externalRuntimeDirectory = path.join(externalRoot, 'runtime');
      const externalSentinelPath = path.join(externalRuntimeDirectory, 'external-sentinel.txt');
      await fs.mkdir(externalRuntimeDirectory);
      await fs.writeFile(externalSentinelPath, 'do-not-publish-here', 'utf8');

      const originalUnlink = fs.unlink.bind(fs);
      let substituted = false;
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        await originalUnlink(target);
        if (!substituted && target.toString().startsWith('/proc/self/fd/')) {
          await fs.rename(runtimeDirectory, admittedRuntimeDirectory);
          await fs.symlink(externalRuntimeDirectory, runtimeDirectory, 'dir');
          substituted = true;
        }
      });

      try {
        await expect(
          prepareOpenCodeRuntimeLaneForLaunchGeneration({
            teamsBasePath: tempDir,
            teamName,
            laneId,
            runId: 'run-new',
            reason: 'test_publication_replacement',
            clock: () => now,
          })
        ).resolves.toMatchObject({ reset: true, reason: 'active_run_mismatch' });

        expect(substituted).toBe(true);
        await expect(fs.readFile(externalSentinelPath, 'utf8')).resolves.toBe(
          'do-not-publish-here'
        );
        await expect(fs.readdir(externalRuntimeDirectory)).resolves.toEqual([
          'external-sentinel.txt',
        ]);
        const admittedIndex = JSON.parse(
          await fs.readFile(path.join(admittedRuntimeDirectory, 'lanes.json'), 'utf8')
        ) as { lanes: Record<string, { runId?: string }> };
        expect(admittedIndex.lanes[laneId]?.runId).toBe('run-new');
        const admittedManifest = JSON.parse(
          await fs.readFile(
            path.join(
              admittedRuntimeDirectory,
              'lanes',
              encodeURIComponent(laneId),
              'manifest.json'
            ),
            'utf8'
          )
        ) as { data: { activeRunId: string | null } };
        expect(admittedManifest.data.activeRunId).toBe('run-new');
      } finally {
        unlinkSpy.mockRestore();
        await fs.rm(externalRoot, { recursive: true, force: true });
      }
    }
  );

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
