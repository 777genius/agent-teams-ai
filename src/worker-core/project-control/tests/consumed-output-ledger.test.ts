import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProjectDebtReason,
  consumedDebt,
  consumedOutputRecordFor,
  consumedOutputRecordFromJson,
  type ConsumedOutputLedger,
  type ConsumedOutputLedgerPathAccess,
  type ConsumedOutputRecord,
} from "../index";

describe("consumed output ledger", () => {
  it("accepts terminal drain records with backup evidence", async () => {
    const paths = new Set<string>();
    const pathAccess = testPathAccess(paths);
    const root = "/tmp/subscription-runtime-consumed-ledger";
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    const backup = createBackupEvidence(paths, root, "infinity-context-memory-v1", workspace);

    for (const status of ["duplicate", "superseded", "rejected", "archived"]) {
      const record = await consumedOutputRecordFromJson({
        ledgerPath: join(root, `${status}.json`),
        pathAccess,
        value: {
          jobId: `infinity-context-memory-${status}`,
          status,
          closedAt: "2026-07-06T00:00:00.000Z",
          backup,
        },
      });

      expect(record).toMatchObject({
        status,
        valid: true,
      });
      expect(consumedDebt(record!)).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.ConsumedDirtyWorkspace,
          severity: "info",
        }),
      ]);
    }
  });

  it("requires commit evidence for integrated records", async () => {
    const paths = new Set<string>();
    const pathAccess = testPathAccess(paths);
    const root = "/tmp/subscription-runtime-integrated-ledger";
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    const backup = createBackupEvidence(paths, root, "infinity-context-memory-v1", workspace);

    await expect(consumedOutputRecordFromJson({
      ledgerPath: join(root, "integrated.json"),
      pathAccess,
      value: {
        jobId: "infinity-context-memory-v1",
        status: "integrated",
        closedAt: "2026-07-06T00:00:00.000Z",
        commitSha: "abc1234",
        backup,
      },
    })).resolves.toMatchObject({
      valid: true,
      commitSha: "abc1234",
    });

    const missingCommit = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "integrated-missing-commit.json"),
      pathAccess,
      value: {
        jobId: "infinity-context-memory-v1",
        status: "integrated",
        closedAt: "2026-07-06T00:00:00.000Z",
        backup,
      },
    });

    expect(missingCommit).toMatchObject({
      valid: false,
      evidence: expect.arrayContaining([
        "integrated consumed-output record is missing commit evidence",
      ]),
    });
    expect(consumedDebt(missingCommit!)).toEqual([
      expect.objectContaining({
        reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
        severity: "blocking",
      }),
    ]);
  });

  it("rejects terminal records without complete backup or with active claims", async () => {
    const paths = new Set<string>();
    const pathAccess = testPathAccess(paths);
    const root = "/tmp/subscription-runtime-invalid-ledger";
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");

    const missingBackup = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "missing-backup.json"),
      pathAccess,
      value: {
        jobId: "infinity-context-memory-v1",
        status: "duplicate",
        closedAt: "2026-07-06T00:00:00.000Z",
      },
    });
    expect(missingBackup).toMatchObject({
      valid: false,
      evidence: expect.arrayContaining([
        "terminal consumed-output record is missing backup",
      ]),
    });

    const backup = createBackupEvidence(paths, root, "infinity-context-memory-v1", workspace);
    const claimed = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "claimed.json"),
      pathAccess,
      value: {
        jobId: "infinity-context-memory-v1",
        status: "duplicate",
        closedAt: "2026-07-06T00:00:00.000Z",
        backup,
        claim: { owner: "worker-a" },
      },
    });
    expect(claimed).toMatchObject({
      valid: false,
      evidence: expect.arrayContaining([
        "terminal consumed-output record still has active claim",
      ]),
    });
  });

  it("matches workspace symlink realpaths and blocks job/workspace mismatches", async () => {
    const paths = new Set<string>();
    const root = "/tmp/subscription-runtime-ledger-match";
    const realWorkspace = join(root, "real", "infinity-context-memory-v1");
    const linkWorkspace = join(root, "links", "infinity-context-memory-v1");
    const otherWorkspace = join(root, "real", "infinity-context-memory-other");
    const pathAccess = testPathAccess(paths, new Map([
      [realWorkspace, realWorkspace],
      [linkWorkspace, realWorkspace],
      [otherWorkspace, otherWorkspace],
    ]));

    const record = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "ledger", "items", "infinity-context-memory-v1.json"),
      pathAccess,
      value: {
        jobId: "infinity-context-memory-v1",
        status: "duplicate",
        closedAt: "2026-07-06T00:00:00.000Z",
        backup: createBackupEvidence(
          paths,
          root,
          "infinity-context-memory-v1",
          realWorkspace,
        ),
      },
    });
    const ledger = ledgerFromRecord(record!);

    expect(consumedOutputRecordFor({
      ledger,
      jobId: "infinity-context-memory-v1",
      workspacePath: linkWorkspace,
      resolvedWorkspacePath: realWorkspace,
    })).toMatchObject({
      valid: true,
      workspace: realWorkspace,
    });

    expect(consumedOutputRecordFor({
      ledger,
      jobId: "infinity-context-memory-other",
      workspacePath: linkWorkspace,
      resolvedWorkspacePath: realWorkspace,
    })).toMatchObject({
      valid: false,
      evidence: expect.arrayContaining([
        "ledger jobId infinity-context-memory-v1 does not match dirty jobId infinity-context-memory-other",
      ]),
    });

    expect(consumedOutputRecordFor({
      ledger,
      jobId: "infinity-context-memory-v1",
      workspacePath: otherWorkspace,
      resolvedWorkspacePath: otherWorkspace,
    })).toMatchObject({
      valid: false,
      evidence: expect.arrayContaining([
        `ledger workspace ${realWorkspace} does not match dirty workspace ${otherWorkspace}`,
      ]),
    });
  });
});

function createBackupEvidence(
  paths: Set<string>,
  root: string,
  jobId: string,
  workspace: string,
): Record<string, string> {
  const backupRoot = join(root, "backups", jobId);
  const statusPath = join(backupRoot, "status.txt");
  const patchPath = join(backupRoot, "tracked.patch");
  const numstatPath = join(backupRoot, "numstat.txt");
  paths.add(statusPath);
  paths.add(patchPath);
  paths.add(numstatPath);
  return {
    workspace,
    statusPath,
    patchPath,
    numstatPath,
  };
}

function testPathAccess(
  paths: ReadonlySet<string>,
  realpaths: ReadonlyMap<string, string> = new Map(),
): ConsumedOutputLedgerPathAccess {
  return {
    pathExists: (path) => paths.has(path),
    realpath: (path) => realpaths.get(path) ?? path,
  };
}

function ledgerFromRecord(record: ConsumedOutputRecord): ConsumedOutputLedger {
  const byWorkspace = new Map<string, ConsumedOutputRecord>();
  if (record.workspace) byWorkspace.set(resolve(record.workspace), record);
  if (record.resolvedWorkspace) byWorkspace.set(record.resolvedWorkspace, record);
  return {
    byJobId: new Map([[record.jobId, record]]),
    byWorkspace,
    debt: [],
  };
}
