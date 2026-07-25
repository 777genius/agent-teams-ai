import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type {
  ConsumedOutputLedgerWriterPort,
  IntegratedOutputLedgerPort,
  IntegratedOutputLedgerPreparation,
  IntegratedOutputLedgerReceipt,
  IntegrationAttempt,
  RejectedOutputLedgerPreparation,
  RejectedOutputLedgerReceipt,
  TerminalOutputDecision,
  TerminalOutputDecisionReceipt,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);

export class LocalConsumedOutputLedgerWriter
  implements ConsumedOutputLedgerWriterPort {
  async assertCanRecord(input: {
    readonly ledgerRoot: string;
    readonly decision: TerminalOutputDecision;
  }): Promise<void> {
    await resolveTerminalLedgerWriteTarget(input);
  }

  async record(input: {
    readonly ledgerRoot: string;
    readonly decision: TerminalOutputDecision;
  }): Promise<TerminalOutputDecisionReceipt> {
    const target = await resolveTerminalLedgerWriteTarget(input);
    if (target.idempotentReplay) {
      return {
        ledgerPath: target.ledgerPath,
        decision: input.decision,
        idempotentReplay: true,
      };
    }
    const ledgerPath = target.ledgerPath;
    await mkdir(dirname(ledgerPath), { recursive: true });
    const contents = `${JSON.stringify(target.record, null, 2)}\n`;
    const tmpPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, contents, { flag: "wx" });
    try {
      await link(tmpPath, ledgerPath);
      return { ledgerPath, decision: input.decision, idempotentReplay: false };
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
      const existing = await readFile(ledgerPath, "utf8");
      if (!sameLedgerRecord(existing, target.record)) {
        return await this.record(input);
      }
      return { ledgerPath, decision: input.decision, idempotentReplay: true };
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}

export type LocalTerminalOutputBackupCapture = {
  readonly archivePath: string;
  readonly statusPath: string;
  readonly patchPath: string;
  readonly numstatPath: string;
  readonly hasAuthoredOutput: boolean;
};

export async function captureLocalTerminalOutputBackup(input: {
  readonly archiveRoot: string;
  readonly archiveName: string;
  readonly workspacePath: string;
  readonly changedFiles: readonly string[];
  readonly sourcePatchPath?: string;
  readonly gitBinaryPath?: string;
}): Promise<LocalTerminalOutputBackupCapture> {
  const archivePath = join(input.archiveRoot, safeLedgerName(input.archiveName));
  await mkdir(archivePath, { recursive: true });
  const statusPath = join(archivePath, "git-status.txt");
  const patchPath = join(archivePath, "tracked.diff");
  const numstatPath = join(archivePath, "tracked.numstat");
  await publishExactText(statusPath, await localGitOutput({
    cwd: input.workspacePath,
    args: ["status", "--short"],
    ...(input.gitBinaryPath ? { gitBinaryPath: input.gitBinaryPath } : {}),
  }));
  if (input.sourcePatchPath) {
    await publishExactFile(patchPath, input.sourcePatchPath);
  } else {
    await publishExactBytes(
      patchPath,
      input.changedFiles.length === 0
        ? Buffer.alloc(0)
        : await localGitOutputBytes({
            cwd: input.workspacePath,
            args: ["diff", "--binary", "--", ...input.changedFiles],
            ...(input.gitBinaryPath ? { gitBinaryPath: input.gitBinaryPath } : {}),
          }),
    );
  }
  await publishExactText(
    numstatPath,
    input.changedFiles.length === 0
      ? ""
      : await localGitOutput({
          cwd: input.workspacePath,
          args: ["diff", "--numstat", "--", ...input.changedFiles],
          ...(input.gitBinaryPath ? { gitBinaryPath: input.gitBinaryPath } : {}),
        }),
  );
  return {
    archivePath,
    statusPath,
    patchPath,
    numstatPath,
    hasAuthoredOutput: await anyFileHasBytes([patchPath, numstatPath]),
  };
}

export type LocalIntegratedOutputLedgerAdapterOptions = {
  readonly ledgerRoots: readonly string[];
  readonly archiveRoot: string;
  readonly gitBinaryPath?: string;
  readonly resolveWorkerWorkspacePath?: (
    workerJobId: string,
  ) => Promise<string | undefined>;
};

export class LocalIntegratedOutputLedgerAdapter
  implements IntegratedOutputLedgerPort {
  private readonly writer = new LocalConsumedOutputLedgerWriter();

  constructor(private readonly options: LocalIntegratedOutputLedgerAdapterOptions) {}

  async prepare(input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }): Promise<IntegratedOutputLedgerPreparation> {
    const ledgerRoot = this.requiredLedgerRoot();
    const workerWorkspacePath = await this.workerWorkspacePath(input.attempt);
    const archivePath = join(
      this.options.archiveRoot,
      `${safeLedgerName(input.attempt.workerOutput.workerJobId)}-integrated-${input.commitSha.slice(0, 12)}-${safeLedgerName(input.attempt.attemptId)}`,
    );
    await mkdir(archivePath, { recursive: true });
    const statusPath = await publishCorrectableText(
      join(archivePath, "git-status.txt"),
      await this.gitOutput(workerWorkspacePath, ["status", "--short"]),
    );
    const patchPath = join(archivePath, "tracked.diff");
    const numstatPath = join(archivePath, "tracked.numstat");
    await publishExactBytes(patchPath, await this.gitOutputBytes(
      input.attempt.targetWorkspacePath,
      ["show", "--format=", "--binary", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles],
    ));
    await publishExactText(numstatPath, await this.gitOutput(
      input.attempt.targetWorkspacePath,
      ["show", "--format=", "--numstat", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles],
    ));
    const preparation: IntegratedOutputLedgerPreparation = {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath,
      commitSha: input.commitSha,
      archivePath,
      statusPath,
      patchPath,
      numstatPath,
    };
    await publishCorrectableJson(
      join(ledgerRoot, "preparations", `${safeLedgerName(input.attempt.attemptId)}.json`),
      preparation,
    );
    return preparation;
  }

  async preflightFinalize(input: {
    readonly preparation: IntegratedOutputLedgerPreparation;
    readonly pushedAt?: string;
  }): Promise<void> {
    await this.writer.assertCanRecord({
      ledgerRoot: this.requiredLedgerRoot(),
      decision: integratedDecision(
        input.preparation,
        input.pushedAt ?? "1970-01-01T00:00:00.000Z",
      ),
    });
  }

  async finalize(input: {
    readonly preparation: IntegratedOutputLedgerPreparation;
    readonly pushedAt: string;
  }): Promise<IntegratedOutputLedgerReceipt> {
    const ledgerRoot = this.requiredLedgerRoot();
    const receipt = await this.writer.record({
      ledgerRoot,
      decision: integratedDecision(input.preparation, input.pushedAt),
    });
    return {
      ledgerPath: receipt.ledgerPath,
      archivePath: input.preparation.archivePath,
      commitSha: input.preparation.commitSha,
      idempotentReplay: receipt.idempotentReplay,
    };
  }

  async prepareRejection(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<RejectedOutputLedgerPreparation> {
    const ledgerRoot = this.requiredLedgerRoot();
    const workerWorkspacePath = await this.workerWorkspacePath(input.attempt);
    const captured = await captureLocalTerminalOutputBackup({
      archiveRoot: this.options.archiveRoot,
      archiveName:
        `${input.attempt.workerOutput.workerJobId}-rejected-${input.attempt.attemptId}`,
      workspacePath: workerWorkspacePath,
      changedFiles: input.attempt.workerOutput.changedFiles,
      ...(input.attempt.workerOutput.patchPath
        ? { sourcePatchPath: input.attempt.workerOutput.patchPath }
        : {}),
      ...(this.options.gitBinaryPath
        ? { gitBinaryPath: this.options.gitBinaryPath }
        : {}),
    });
    const preparation: RejectedOutputLedgerPreparation = {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath,
      ...captured,
    };
    await publishExactJson(
      join(
        ledgerRoot,
        "rejection-preparations",
        `${safeLedgerName(input.attempt.attemptId)}.json`,
      ),
      preparation,
    );
    return preparation;
  }

  async finalizeRejection(input: {
    readonly preparation: RejectedOutputLedgerPreparation;
    readonly rejectedAt: string;
    readonly reason: string;
  }): Promise<RejectedOutputLedgerReceipt> {
    const ledgerRoot = this.requiredLedgerRoot();
    const status = input.preparation.hasAuthoredOutput
      ? "rejected"
      : "failed_no_output";
    const note = input.preparation.hasAuthoredOutput
      ? `Rejected reviewed worker output via project lifecycle attempt ${input.preparation.attemptId}: ${input.reason}`
      : `Closed attempt ${input.preparation.attemptId} without archived authored output: ${input.reason}`;
    const receipt = await this.writer.record({
      ledgerRoot,
      decision: {
        schemaVersion: 1,
        jobId: input.preparation.workerJobId,
        attemptId: input.preparation.attemptId,
        status,
        closedAt: input.rejectedAt,
        archivePath: input.preparation.archivePath,
        ...(status === "failed_no_output"
          ? {
              failure: {
                category: "infrastructure",
                code: "rejected_without_authored_output",
              },
              output: { authoredChanges: false, workspaceDirty: false },
            }
          : {}),
        note,
        backup: {
          workspace: input.preparation.workerWorkspacePath,
          statusPath: input.preparation.statusPath,
          patchPath: input.preparation.patchPath,
          numstatPath: input.preparation.numstatPath,
        },
      },
    });
    return {
      ledgerPath: receipt.ledgerPath,
      archivePath: input.preparation.archivePath,
      status,
      idempotentReplay: receipt.idempotentReplay,
    };
  }

  private requiredLedgerRoot(): string {
    if (this.options.ledgerRoots.length !== 1) {
      throw new Error("project_integration_consumed_output_ledger_required");
    }
    return this.options.ledgerRoots[0]!;
  }

  private async workerWorkspacePath(
    attempt: IntegrationAttempt,
  ): Promise<string> {
    return (
      await this.options.resolveWorkerWorkspacePath?.(
        attempt.workerOutput.workerJobId,
      )
    ) ?? attempt.workerOutput.workspacePath;
  }

  private async gitOutput(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFileAsync(
      this.options.gitBinaryPath ?? "git",
      [...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    );
    return result.stdout;
  }

  private async gitOutputBytes(
    cwd: string,
    args: readonly string[],
  ): Promise<Buffer> {
    const result = await execFileAsync(
      this.options.gitBinaryPath ?? "git",
      [...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    return result.stdout;
  }
}

async function localGitOutput(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly gitBinaryPath?: string;
}): Promise<string> {
  const result = await execFileAsync(
    input.gitBinaryPath ?? "git",
    [...input.args],
    { cwd: input.cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
  );
  return result.stdout;
}

async function localGitOutputBytes(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly gitBinaryPath?: string;
}): Promise<Buffer> {
  const result = await execFileAsync(
    input.gitBinaryPath ?? "git",
    [...input.args],
    {
      cwd: input.cwd,
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  return result.stdout;
}

function sameTerminalDecision(
  existingJson: string,
  decision: TerminalOutputDecision,
): boolean {
  return sameLedgerRecord(existingJson, ledgerRecord(decision));
}

function sameLedgerRecord(
  existingJson: string,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  try {
    const existing: unknown = JSON.parse(existingJson);
    return isDeepStrictEqual(existing, expected);
  } catch {
    return false;
  }
}

async function resolveTerminalLedgerWriteTarget(input: {
  readonly ledgerRoot: string;
  readonly decision: TerminalOutputDecision;
}): Promise<{
  readonly ledgerPath: string;
  readonly idempotentReplay: boolean;
  readonly record: Readonly<Record<string, unknown>>;
}> {
  const ledgerPath = terminalLedgerPath(input.ledgerRoot, input.decision);
  const record = ledgerRecord(input.decision);
  let existing: string;
  try {
    existing = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { ledgerPath, idempotentReplay: false, record };
    }
    throw error;
  }
  if (sameTerminalDecision(existing, input.decision)) {
    return { ledgerPath, idempotentReplay: true, record };
  }
  const correction = integratedWorkspaceCorrection({
    ledgerPath,
    existingJson: existing,
    decision: input.decision,
  });
  if (!correction) {
    throw new Error("consumed_output_ledger_terminal_conflict");
  }
  try {
    const existingCorrection = await readFile(correction.ledgerPath, "utf8");
    if (!sameLedgerRecord(existingCorrection, correction.record)) {
      throw new Error("consumed_output_ledger_terminal_conflict");
    }
    return {
      ledgerPath: correction.ledgerPath,
      idempotentReplay: true,
      record: correction.record,
    };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return {
        ledgerPath: correction.ledgerPath,
        idempotentReplay: false,
        record: correction.record,
      };
    }
    throw error;
  }
}

function integratedWorkspaceCorrection(input: {
  readonly ledgerPath: string;
  readonly existingJson: string;
  readonly decision: TerminalOutputDecision;
}): {
  readonly ledgerPath: string;
  readonly record: Readonly<Record<string, unknown>>;
} | undefined {
  if (input.decision.status !== "integrated") return undefined;
  try {
    const existing: unknown = JSON.parse(input.existingJson);
    const expected = ledgerRecord(input.decision);
    if (!isRecord(existing)) return undefined;
    const existingBackup = existing.backup;
    const expectedBackup = expected.backup;
    if (!isRecord(existingBackup) || !isRecord(expectedBackup)) {
      return undefined;
    }
    if (
      typeof existingBackup.workspace !== "string" ||
      typeof expectedBackup.workspace !== "string" ||
      existingBackup.workspace === expectedBackup.workspace ||
      typeof existingBackup.statusPath !== "string" ||
      typeof expectedBackup.statusPath !== "string"
    ) {
      return undefined;
    }
    const expectedWithPriorWorkspaceEvidence = {
      ...expected,
      backup: {
        ...expectedBackup,
        workspace: existingBackup.workspace,
        statusPath: existingBackup.statusPath,
      },
    };
    if (!isDeepStrictEqual(existing, expectedWithPriorWorkspaceEvidence)) {
      return undefined;
    }
    const correctedRecord = {
      ...expected,
      correctionOf: {
        kind: "integrated_workspace_binding",
        ledgerFile: basename(input.ledgerPath),
        sha256: createHash("sha256")
          .update(input.existingJson)
          .digest("hex"),
      },
    };
    const desiredHash = createHash("sha256")
      .update(JSON.stringify(correctedRecord))
      .digest("hex")
      .slice(0, 16);
    return {
      ledgerPath: input.ledgerPath.replace(
        /\.json$/,
        `.workspace-correction-${desiredHash}.json`,
      ),
      record: correctedRecord,
    };
  } catch {
    return undefined;
  }
}

async function publishExactJson(path: string, value: unknown): Promise<void> {
  await publishExactText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function publishCorrectableJson(
  path: string,
  value: unknown,
): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await publishCorrectableText(path, contents);
}

async function publishCorrectableText(
  path: string,
  contents: string,
): Promise<string> {
  try {
    await publishExactText(path, contents);
    return path;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "integrated_output_ledger_preparation_conflict"
    ) {
      throw error;
    }
  }
  const contentsHash = createHash("sha256")
    .update(contents)
    .digest("hex")
    .slice(0, 16);
  const correctionPath = path.replace(
    /(\.[^.]+)$/,
    `.workspace-correction-${contentsHash}$1`,
  );
  await publishExactText(correctionPath, contents);
  return correctionPath;
}

async function publishExactFile(path: string, sourcePath: string): Promise<void> {
  await publishExactBytes(path, await readFile(sourcePath));
}

async function anyFileHasBytes(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if ((await stat(path)).size > 0) return true;
  }
  return false;
}

async function publishExactText(path: string, contents: string): Promise<void> {
  await publishExactBytes(path, Buffer.from(contents));
}

async function publishExactBytes(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, contents, { flag: "wx" });
  try {
    await link(tmpPath, path);
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) throw error;
    if (!(await readFile(path)).equals(contents)) {
      throw new Error("integrated_output_ledger_preparation_conflict");
    }
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

function ledgerRecord(decision: TerminalOutputDecision): Record<string, unknown> {
  return {
    ...decision,
    consumedAt: decision.closedAt,
    ...(decision.commitSha
      ? {
          integratedCommitSha: decision.commitSha,
          commit: decision.commitSha,
        }
      : {}),
    notes: [{
      status: decision.status,
      text: decision.note,
      ...(decision.commitSha ? { commit: decision.commitSha } : {}),
    }],
  };
}

function integratedDecision(
  preparation: IntegratedOutputLedgerPreparation,
  pushedAt: string,
): TerminalOutputDecision {
  return {
    schemaVersion: 1,
    jobId: preparation.workerJobId,
    attemptId: preparation.attemptId,
    status: "integrated",
    closedAt: pushedAt,
    commitSha: preparation.commitSha,
    archivePath: preparation.archivePath,
    note: `Integrated reviewed worker output via project lifecycle attempt ${preparation.attemptId}.`,
    backup: {
      workspace: preparation.workerWorkspacePath,
      statusPath: preparation.statusPath,
      patchPath: preparation.patchPath,
      numstatPath: preparation.numstatPath,
    },
  };
}

function terminalLedgerPath(
  ledgerRoot: string,
  decision: TerminalOutputDecision,
): string {
  const attemptSuffix = decision.attemptId
    ? `--${safeLedgerName(decision.attemptId)}`
    : "";
  return join(
    ledgerRoot,
    "items",
    `${safeLedgerName(decision.jobId)}${attemptSuffix}.json`,
  );
}

function safeLedgerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
