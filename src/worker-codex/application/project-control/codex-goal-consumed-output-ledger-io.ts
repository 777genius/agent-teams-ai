import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  consumedOutputRecordFor,
  readConsumedOutputLedgers,
  type ConsumedOutputRecord,
  type ConsumedOutputLedger,
  type ConsumedOutputLedgerEntry,
  type ConsumedOutputLedgerReadFailure,
  type ConsumedOutputLedgerSourcePort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  assertReviewedWorkerContinuationContext,
  type ReviewedWorkerOutputSnapshot,
} from "../../reviewed-worker-output";

export async function readCodexGoalConsumedOutputLedgers(input: {
  readonly roots: readonly string[];
  readonly source?: ConsumedOutputLedgerSourcePort;
}): Promise<ConsumedOutputLedger> {
  return readConsumedOutputLedgers({
    roots: input.roots,
    source: input.source ?? new LocalConsumedOutputLedgerSource(input.roots),
  });
}

export function rejectedUncapturedOutputPatchSha256(
  record: ConsumedOutputRecord,
): string | undefined {
  if (record.status !== "rejected" || !record.valid) return undefined;
  const match = record.attemptId?.match(
    /^uncaptured-rejection-([a-f0-9]{64})$/i,
  );
  if (!match || !record.backupPatchSha256) return undefined;
  const patchSha256 = match[1]!.toLowerCase();
  return record.backupPatchSha256.toLowerCase() === patchSha256
    ? patchSha256
    : undefined;
}

export function resolveRejectedUncapturedOutputPatchSha256(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly jobId: string;
  readonly workspacePath: string;
}): string | undefined {
  if (hasRelevantConsumedOutputDebt(input.ledger, input.jobId)) {
    return undefined;
  }
  const record = consumedOutputRecordFor({
    ledger: input.ledger,
    jobId: input.jobId,
    workspacePath: input.workspacePath,
  });
  return record ? rejectedUncapturedOutputPatchSha256(record) : undefined;
}

export async function assertCodexGoalProjectJobNotTerminal(input: {
  readonly roots: readonly string[];
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly reviewedContinuation?: ReviewedWorkerOutputSnapshot;
  readonly capacityContinuation?: true;
  readonly rejectedUncapturedContinuationPatchSha256?: string;
}): Promise<void> {
  if (
    input.rejectedUncapturedContinuationPatchSha256 &&
    input.roots.length !== 1
  ) {
    throw new Error(
      "project_control_terminal_job_start_denied:rejected_ledger_root_invalid",
    );
  }
  if (input.roots.length === 0) {
    return;
  }
  const ledger = await readCodexGoalConsumedOutputLedgers({
    roots: input.roots,
  });
  if (input.rejectedUncapturedContinuationPatchSha256) {
    const patchSha256 = resolveRejectedUncapturedOutputPatchSha256({
      ledger,
      jobId: input.jobId,
      workspacePath: input.workspacePath,
    });
    if (
      patchSha256 ===
      input.rejectedUncapturedContinuationPatchSha256.toLowerCase()
    ) {
      return;
    }
    throw new Error(
      "project_control_terminal_job_start_denied:rejected_evidence_mismatch",
    );
  }
  const record = consumedOutputRecordFor({
    ledger,
    jobId: input.jobId,
    workspacePath: input.workspacePath,
  });
  if (!record?.valid) return;
  if (record.status === "rejected" && input.reviewedContinuation) {
    assertReviewedWorkerContinuationContext(input.reviewedContinuation, {
      projectId: input.projectId,
      controllerJobId: input.controllerJobId,
      workerJobId: input.jobId,
      taskId: input.taskId,
      workspacePath: resolve(input.workspacePath),
    });
    return;
  }
  // Preserve failed_no_output as immutable evidence for the prior provider
  // attempt while permitting an independently validated capacity continuation.
  if (record.status === "failed_no_output" && input.capacityContinuation) {
    return;
  }
  throw new Error(
    `project_control_terminal_job_start_denied:${record.status}`,
  );
}

export function hasRelevantConsumedOutputDebt(
  ledger: ConsumedOutputLedger,
  jobId: string,
): boolean {
  const safeJobId = jobId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return ledger.debt.some((item) => {
    const subjectName = basename(item.subject);
    return subjectName === "items" ||
      relevantLedgerEntryName(subjectName, safeJobId);
  });
}

class LocalConsumedOutputLedgerSource implements ConsumedOutputLedgerSourcePort {
  private readonly evidenceRoots: readonly string[];

  constructor(ledgerRoots: readonly string[]) {
    this.evidenceRoots = ledgerRoots.map((root) =>
      dirname(dirname(resolve(root)))
    );
  }

  async readEntries(input: {
    readonly roots: readonly string[];
  }): Promise<{
    readonly entries: readonly ConsumedOutputLedgerEntry[];
    readonly failures: readonly ConsumedOutputLedgerReadFailure[];
  }> {
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
          evidence: [
            `consumed output ledger unreadable: ${errorMessage(error)}`,
          ],
        });
        continue;
      }
      for (const entry of dirEntries) {
        if (!entry.name.endsWith(".json")) continue;
        const ledgerPath = join(itemsDir, entry.name);
        if (!entry.isFile()) {
          failures.push({
            subject: ledgerPath,
            evidence: [
              "consumed output ledger record is not a regular file",
            ],
          });
          continue;
        }
        try {
          const value: unknown = JSON.parse(await readFile(ledgerPath, "utf8"));
          if (!ledgerFilenameMatchesPayload(entry.name, value)) {
            failures.push({
              subject: ledgerPath,
              evidence: [
                "consumed output ledger filename does not match payload jobId",
              ],
            });
            continue;
          }
          entries.push({
            ledgerPath,
            value,
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
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async pathSize(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).size;
    } catch {
      return undefined;
    }
  }

  async pathSha256(path: string): Promise<string | undefined> {
    let handle;
    try {
      const realPath = await realpath(path);
      const realEvidenceRoots = await Promise.all(
        this.evidenceRoots.map(async (root) => await realpath(root)),
      );
      if (!realEvidenceRoots.some((root) => pathInsideOrEqual(realPath, root))) {
        return undefined;
      }
      handle = await open(
        realPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
        return undefined;
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < metadata.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, metadata.size - position),
          position,
        );
        if (bytesRead === 0) return undefined;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest("hex");
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async resolveWorkspacePath(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  }
}

function ledgerFilenameMatchesPayload(
  filename: string,
  value: unknown,
): boolean {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    !value.jobId ||
    typeof value.status !== "string" ||
    !value.status
  ) {
    return false;
  }
  const safeJobId = value.jobId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return relevantLedgerEntryName(filename, safeJobId);
}

function relevantLedgerEntryName(filename: string, safeJobId: string): boolean {
  return filename === `${safeJobId}.json` ||
    filename.startsWith(`${safeJobId}--`);
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const pathRelative = relative(resolve(root), resolve(path));
  return pathRelative === "" ||
    (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
