import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProjectDebtReason,
  consumedDebt,
  consumedOutputRecordFor,
  consumedOutputRecordFromJson,
  readConsumedOutputLedgers,
} from "../index";

describe("consumed output ledger", () => {
  it("accepts terminal drain records with backup evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-consumed-ledger-"));
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    const backup = await createBackupEvidence(root, "infinity-context-memory-v1", workspace);

    for (const status of ["duplicate", "superseded", "rejected", "archived"]) {
      const record = await consumedOutputRecordFromJson({
        ledgerPath: join(root, `${status}.json`),
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
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-integrated-ledger-"));
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    const backup = await createBackupEvidence(root, "infinity-context-memory-v1", workspace);

    await expect(consumedOutputRecordFromJson({
      ledgerPath: join(root, "integrated.json"),
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
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-invalid-ledger-"));
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    await mkdir(workspace, { recursive: true });

    const missingBackup = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "missing-backup.json"),
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

    const backup = await createBackupEvidence(root, "infinity-context-memory-v1", workspace);
    const claimed = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "claimed.json"),
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
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-ledger-match-"));
    const ledgerRoot = join(root, "ledger");
    const realWorkspace = join(root, "real", "infinity-context-memory-v1");
    const linkRoot = join(root, "links");
    const linkWorkspace = join(linkRoot, "infinity-context-memory-v1");
    const otherWorkspace = join(root, "real", "infinity-context-memory-other");
    await mkdir(join(ledgerRoot, "items"), { recursive: true });
    await mkdir(linkRoot, { recursive: true });
    await mkdir(otherWorkspace, { recursive: true });
    await createBackupEvidence(root, "infinity-context-memory-v1", realWorkspace);
    await symlink(realWorkspace, linkWorkspace);

    await writeFile(
      join(ledgerRoot, "items", "infinity-context-memory-v1.json"),
      `${JSON.stringify({
        jobId: "infinity-context-memory-v1",
        status: "duplicate",
        closedAt: "2026-07-06T00:00:00.000Z",
        backup: await createBackupEvidence(root, "infinity-context-memory-v1-b", realWorkspace),
      }, null, 2)}\n`,
    );

    const ledger = await readConsumedOutputLedgers({ roots: [ledgerRoot] });
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

    const sharedLedgerRoot = join(root, "shared-ledger");
    const sharedWorkspace = join(root, "shared-control");
    await mkdir(join(sharedLedgerRoot, "items"), { recursive: true });
    await mkdir(sharedWorkspace, { recursive: true });
    await writeFile(
      join(sharedLedgerRoot, "items", "infinity-context-controller-a.json"),
      `${JSON.stringify({
        jobId: "infinity-context-controller-a",
        status: "superseded",
        closedAt: "2026-07-06T00:00:00.000Z",
        backup: await createBackupEvidence(root, "infinity-context-controller-a", sharedWorkspace),
      }, null, 2)}\n`,
    );
    await writeFile(
      join(sharedLedgerRoot, "items", "infinity-context-controller-b.json"),
      `${JSON.stringify({
        jobId: "infinity-context-controller-b",
        status: "superseded",
        closedAt: "2026-07-06T00:00:00.000Z",
        backup: await createBackupEvidence(root, "infinity-context-controller-b", sharedWorkspace),
      }, null, 2)}\n`,
    );

    const sharedLedger = await readConsumedOutputLedgers({ roots: [sharedLedgerRoot] });
    expect(consumedOutputRecordFor({
      ledger: sharedLedger,
      jobId: "infinity-context-controller-a",
      workspacePath: sharedWorkspace,
      resolvedWorkspacePath: sharedWorkspace,
    })).toMatchObject({
      jobId: "infinity-context-controller-a",
      valid: true,
    });
    expect(consumedOutputRecordFor({
      ledger: sharedLedger,
      jobId: "infinity-context-controller-b",
      workspacePath: sharedWorkspace,
      resolvedWorkspacePath: sharedWorkspace,
    })).toMatchObject({
      jobId: "infinity-context-controller-b",
      valid: true,
    });
  });
});

async function createBackupEvidence(
  root: string,
  jobId: string,
  workspace: string,
): Promise<Record<string, string>> {
  await mkdir(workspace, { recursive: true });
  const backupRoot = join(root, "backups", jobId);
  await mkdir(backupRoot, { recursive: true });
  const statusPath = join(backupRoot, "status.txt");
  const patchPath = join(backupRoot, "tracked.patch");
  const numstatPath = join(backupRoot, "numstat.txt");
  await writeFile(statusPath, " M memory.py\n");
  await writeFile(patchPath, "diff --git a/memory.py b/memory.py\n");
  await writeFile(numstatPath, "1\t1\tmemory.py\n");
  return {
    workspace,
    statusPath,
    patchPath,
    numstatPath,
  };
}
