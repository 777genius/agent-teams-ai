import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProjectDebtReason,
  consumedDebt,
  consumedOutputRecordFor,
  consumedOutputRecordFromJson,
  readConsumedOutputLedgers,
  type ConsumedOutputLedgerEntry,
  type ConsumedOutputLedgerReadFailure,
  type ConsumedOutputLedgerSourcePort,
} from "../index";

describe("consumed output ledger", () => {
  it.each([
    { name: "incomplete terminal schema", value: { jobId: "worker-1", status: "rejected" } },
    { name: "unknown terminal status", value: { jobId: "worker-1", status: "unknown" } },
    { name: "invalid terminal closedAt", value: { jobId: "worker-1", status: "rejected", closedAt: "not-a-date" } },
  ])("records $name as blocking ledger debt", async ({ value }) => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-ledger-invalid-"));
    const ledgerPath = join(root, "worker-1--zz.json");
    const source: ConsumedOutputLedgerSourcePort = {
      ...localConsumedOutputLedgerSource(),
      async readEntries() {
        return { entries: [{ ledgerPath, value }], failures: [] };
      },
    };

    const ledger = await readConsumedOutputLedgers({ roots: [root], source });

    expect(ledger.debt).toContainEqual(expect.objectContaining({
      reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
      subject: ledgerPath,
      severity: "blocking",
    }));
  });

  it("selects the latest attempt record deterministically for the same job", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-ledger-latest-"));
    const workspace = join(root, "workspace");
    const backup = await createBackupEvidence(root, "worker-1", workspace);
    const local = localConsumedOutputLedgerSource();
    const source: ConsumedOutputLedgerSourcePort = {
      ...local,
      async readEntries() {
        return {
          entries: [
            {
              ledgerPath: join(root, "worker-1--integrated.json"),
              value: {
                jobId: "worker-1",
                status: "integrated",
                closedAt: "2026-07-12T01:00:00.000Z",
                integratedCommitSha: "abc1234",
                backup,
              },
            },
            {
              ledgerPath: join(root, "worker-1--rejected.json"),
              value: {
                jobId: "worker-1",
                status: "rejected",
                closedAt: "2026-07-12T00:00:00.000Z",
                backup,
              },
            },
          ],
          failures: [],
        };
      },
    };

    const ledger = await readConsumedOutputLedgers({ roots: [root], source });

    expect(ledger.byJobId.get("worker-1")).toMatchObject({
      status: "integrated",
      commitSha: "abc1234",
    });
  });

  it("accepts terminal drain records with backup evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-consumed-ledger-"));
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    const backup = await createBackupEvidence(root, "infinity-context-memory-v1", workspace);

    for (const status of ["duplicate", "superseded", "rejected", "archived"]) {
      const record = await consumedOutputRecordFromJson({
        ledgerPath: join(root, `${status}.json`),
        source: localConsumedOutputLedgerSource(),
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

  it("distinguishes infrastructure failures without output from rejected patches", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-no-output-ledger-"));
    const workspace = join(root, "workspaces", "runtime-review-v1");
    const backup = await createBackupEvidence(root, "runtime-review-v1", workspace, false);
    const source = localConsumedOutputLedgerSource();

    const failed = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "failed-no-output.json"),
      source,
      value: {
        jobId: "runtime-review-v1",
        status: "failed_no_output",
        closedAt: "2026-07-11T00:00:00.000Z",
        failure: {
          category: "infrastructure",
          code: "model_requires_newer_version",
        },
        output: {
          authoredChanges: false,
          workspaceDirty: false,
        },
        backup,
      },
    });

    expect(failed).toMatchObject({
      status: "failed_no_output",
      hasAuthoredOutput: false,
      valid: true,
    });
    expect(consumedDebt(failed!)).toEqual([]);

    const ledger = await readConsumedOutputLedgers({
      roots: [],
      source,
    });
    const withFailedRecord = {
      ...ledger,
      byJobId: new Map([[failed!.jobId, failed!]]),
    };
    expect(consumedOutputRecordFor({
      ledger: withFailedRecord,
      jobId: failed!.jobId,
      workspacePath: workspace,
    })).toMatchObject({
      status: "failed_no_output",
      valid: true,
    });
    expect(consumedOutputRecordFor({
      ledger: withFailedRecord,
      jobId: "another-runtime-review",
      workspacePath: workspace,
    })).toBeUndefined();

    const mislabeled = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "mislabeled-rejected.json"),
      source,
      value: {
        jobId: "runtime-review-v1",
        status: "rejected",
        closedAt: "2026-07-11T00:00:00.000Z",
        backup,
      },
    });
    expect(mislabeled).toMatchObject({
      hasAuthoredOutput: false,
      valid: false,
      evidence: expect.arrayContaining([
        "terminal output status rejected has no authored output evidence; use failed_no_output for infrastructure failures",
      ]),
    });
  });

  it("accepts a failed verifier with a verified preexisting workspace patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-preexisting-ledger-"));
    const workspace = join(root, "workspaces", "verifier-v1");
    const backup = await createBackupEvidence(root, "verifier-v1", workspace, false);
    await writeFile(backup.statusPath!, " M producer-output.ts\n");
    const preexistingPatchPath = join(
      dirname(backup.statusPath!),
      "producer.patch",
    );
    const preexistingPatch = "diff --git a/producer-output.ts b/producer-output.ts\n";
    await writeFile(preexistingPatchPath, preexistingPatch);

    const value = {
      jobId: "verifier-v1",
      status: "failed_no_output",
      closedAt: "2026-07-13T00:00:00.000Z",
      failure: { category: "infrastructure", code: "terminal_result_missing" },
      output: { authoredChanges: false, workspaceDirty: false },
      preexistingWorkspacePatch: {
        path: preexistingPatchPath,
        sha256: createHash("sha256").update(preexistingPatch).digest("hex"),
      },
      backup,
    };
    const record = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "failed-verifier.json"),
      source: localConsumedOutputLedgerSource(),
      value,
    });

    expect(record).toMatchObject({
      status: "failed_no_output",
      preexistingWorkspacePatchValid: true,
      valid: true,
    });
    expect(consumedDebt(record!)).toEqual([]);

    await writeFile(preexistingPatchPath, "mutated evidence\n");
    await expect(consumedOutputRecordFromJson({
      ledgerPath: join(root, "failed-verifier.json"),
      source: localConsumedOutputLedgerSource(),
      value,
    })).resolves.toMatchObject({
      preexistingWorkspacePatchValid: false,
      valid: false,
      evidence: expect.arrayContaining([
        `preexisting workspace patch hash mismatch: ${preexistingPatchPath}`,
      ]),
    });
  });

  it("requires commit evidence for integrated records", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-integrated-ledger-"));
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    const backup = await createBackupEvidence(root, "infinity-context-memory-v1", workspace);

    await expect(consumedOutputRecordFromJson({
      ledgerPath: join(root, "integrated.json"),
      source: localConsumedOutputLedgerSource(),
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

    const emptyBackup = await createBackupEvidence(
      root,
      "integrated-with-pruned-patch",
      workspace,
      false,
    );
    await expect(consumedOutputRecordFromJson({
      ledgerPath: join(root, "integrated-with-pruned-patch.json"),
      source: localConsumedOutputLedgerSource(),
      value: {
        jobId: "integrated-with-pruned-patch",
        status: "integrated",
        closedAt: "2026-07-06T00:00:00.000Z",
        commitSha: "def5678",
        backup: emptyBackup,
      },
    })).resolves.toMatchObject({
      valid: true,
      hasAuthoredOutput: true,
      commitSha: "def5678",
    });

    const missingCommit = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "integrated-missing-commit.json"),
      source: localConsumedOutputLedgerSource(),
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

  it("records reviewed no-change output separately from infrastructure failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-no-change-ledger-"));
    const workspace = join(root, "workspaces", "contracts-review-v1");
    const backup = await createBackupEvidence(root, "contracts-review-v1", workspace, false);
    const source = localConsumedOutputLedgerSource();

    const reviewed = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "reviewed-no-change.json"),
      source,
      value: {
        jobId: "contracts-review-v1",
        status: "reviewed_no_change",
        outcome: "reviewed_no_change",
        closedAt: "2026-07-11T00:00:00.000Z",
        backup,
      },
    });

    expect(reviewed).toMatchObject({
      status: "reviewed_no_change",
      hasAuthoredOutput: false,
      valid: true,
    });
    expect(consumedDebt(reviewed!)).toEqual([
      expect.objectContaining({
        reason: ProjectDebtReason.ConsumedDirtyWorkspace,
        severity: "info",
      }),
    ]);

    const ledgerRoot = join(root, "reviewed-ledger");
    await mkdir(join(ledgerRoot, "items"), { recursive: true });
    await writeFile(
      join(ledgerRoot, "items", "contracts-review-v1.json"),
      `${JSON.stringify({
        jobId: "contracts-review-v1",
        status: "reviewed_no_change",
        outcome: "reviewed_no_change",
        closedAt: "2026-07-11T00:00:00.000Z",
        backup,
      }, null, 2)}\n`,
    );
    const ledger = await readConsumedOutputLedgers({
      roots: [ledgerRoot],
      source,
    });

    expect(ledger.byJobId.get("contracts-review-v1")).toMatchObject({
      status: "reviewed_no_change",
      valid: true,
    });
    expect(ledger.byWorkspace.has(resolve(workspace))).toBe(false);
    expect(consumedOutputRecordFor({
      ledger,
      jobId: "contracts-producer-v1",
      workspacePath: workspace,
      resolvedWorkspacePath: workspace,
    })).toBeUndefined();

    const missingOutcome = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "reviewed-no-change-missing-outcome.json"),
      source,
      value: {
        jobId: "contracts-review-v1",
        status: "reviewed_no_change",
        closedAt: "2026-07-11T00:00:00.000Z",
        backup,
      },
    });
    expect(missingOutcome).toMatchObject({
      valid: false,
      evidence: expect.arrayContaining([
        "reviewed_no_change record requires outcome=reviewed_no_change",
      ]),
    });
  });

  it("rejects terminal records without complete backup or with active claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-invalid-ledger-"));
    const workspace = join(root, "workspaces", "infinity-context-memory-v1");
    await mkdir(workspace, { recursive: true });

    const missingBackup = await consumedOutputRecordFromJson({
      ledgerPath: join(root, "missing-backup.json"),
      source: localConsumedOutputLedgerSource(),
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
      source: localConsumedOutputLedgerSource(),
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

    const ledger = await readConsumedOutputLedgers({
      roots: [ledgerRoot],
      source: localConsumedOutputLedgerSource(),
    });
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

    const sharedLedger = await readConsumedOutputLedgers({
      roots: [sharedLedgerRoot],
      source: localConsumedOutputLedgerSource(),
    });
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
  hasAuthoredOutput = true,
): Promise<Record<string, string>> {
  await mkdir(workspace, { recursive: true });
  const backupRoot = join(root, "backups", jobId);
  await mkdir(backupRoot, { recursive: true });
  const statusPath = join(backupRoot, "status.txt");
  const patchPath = join(backupRoot, "tracked.patch");
  const numstatPath = join(backupRoot, "numstat.txt");
  await writeFile(statusPath, hasAuthoredOutput ? " M memory.py\n" : "");
  await writeFile(
    patchPath,
    hasAuthoredOutput ? "diff --git a/memory.py b/memory.py\n" : "",
  );
  await writeFile(numstatPath, hasAuthoredOutput ? "1\t1\tmemory.py\n" : "");
  return {
    workspace,
    statusPath,
    patchPath,
    numstatPath,
  };
}

function localConsumedOutputLedgerSource(): ConsumedOutputLedgerSourcePort {
  return {
    async readEntries(input) {
      const entries: ConsumedOutputLedgerEntry[] = [];
      const failures: ConsumedOutputLedgerReadFailure[] = [];
      for (const rootInput of input.roots) {
        const itemsDir = join(resolve(rootInput), "items");
        let dirEntries;
        try {
          dirEntries = await readdir(itemsDir, { withFileTypes: true });
        } catch (error) {
          failures.push({
            subject: itemsDir,
            evidence: [`consumed output ledger unreadable: ${errorMessage(error)}`],
          });
          continue;
        }
        for (const entry of dirEntries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const ledgerPath = join(itemsDir, entry.name);
          try {
            entries.push({
              ledgerPath,
              value: JSON.parse(await readFile(ledgerPath, "utf8")),
            });
          } catch (error) {
            failures.push({
              subject: ledgerPath,
              evidence: [
                `consumed output ledger record unreadable: ${errorMessage(error)}`,
              ],
            });
          }
        }
      }
      return { entries, failures };
    },
    async pathExists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async pathSize(path) {
      try {
        return (await stat(path)).size;
      } catch {
        return undefined;
      }
    },
    async pathSha256(path) {
      try {
        return createHash("sha256").update(await readFile(path)).digest("hex");
      } catch {
        return undefined;
      }
    },
    async resolveWorkspacePath(path) {
      try {
        return await realpath(path);
      } catch {
        return undefined;
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
