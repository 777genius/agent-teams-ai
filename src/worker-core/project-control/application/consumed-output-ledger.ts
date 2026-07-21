import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "../domain/project-admission";
import type { TerminalOutputBackup } from "../domain/terminal-output-decision";

const CONSUMED_OUTPUT_TERMINAL_STATUSES = new Set([
  "integrated",
  "rejected",
  "duplicate",
  "superseded",
  "archived",
  "failed_no_output",
  "reviewed_no_change",
]);

const NO_OUTPUT_STATUS = "failed_no_output";
const REVIEWED_NO_CHANGE_STATUS = "reviewed_no_change";

export type ConsumedOutputRecord = {
  readonly jobId: string;
  readonly attemptId?: string;
  readonly status: string;
  readonly ledgerPath: string;
  readonly closedAt?: string;
  readonly workspace?: string;
  readonly resolvedWorkspace?: string;
  readonly commitSha?: string;
  readonly backup?: TerminalOutputBackup;
  readonly backupPatchSha256?: string;
  readonly backupEvidenceValid?: boolean;
  readonly backupWorkspaceDirty?: boolean;
  readonly preexistingWorkspacePatchValid?: boolean;
  readonly reclassifiableAsFailedNoOutput?: boolean;
  readonly hasAuthoredOutput: boolean;
  readonly valid: boolean;
  readonly evidence: readonly string[];
};

export type ConsumedOutputLedger = {
  readonly byJobId: ReadonlyMap<string, ConsumedOutputRecord>;
  readonly byWorkspace: ReadonlyMap<string, ConsumedOutputRecord>;
  readonly debt: readonly ProjectDebtItem[];
};

export type ConsumedOutputLedgerEntry = {
  readonly ledgerPath: string;
  readonly value: unknown;
};

export type ConsumedOutputLedgerReadFailure = {
  readonly subject: string;
  readonly evidence: readonly string[];
};

export type ConsumedOutputLedgerSourcePort = {
  readEntries(input: {
    readonly roots: readonly string[];
  }): Promise<{
    readonly entries: readonly ConsumedOutputLedgerEntry[];
    readonly failures: readonly ConsumedOutputLedgerReadFailure[];
  }>;
  pathExists(path: string): Promise<boolean>;
  pathSize(path: string): Promise<number | undefined>;
  pathSha256(path: string): Promise<string | undefined>;
  resolveWorkspacePath(path: string): Promise<string | undefined>;
};

export async function readConsumedOutputLedgers(input: {
  readonly roots: readonly string[];
  readonly source: ConsumedOutputLedgerSourcePort;
}): Promise<ConsumedOutputLedger> {
  const byJobId = new Map<string, ConsumedOutputRecord>();
  const byWorkspace = new Map<string, ConsumedOutputRecord>();
  const loaded = await input.source.readEntries({
    roots: uniqueStrings(input.roots),
  });
  const debt: ProjectDebtItem[] = loaded.failures.map((failure) => ({
    reason: ProjectDebtReason.UnreadableRoot,
    subject: failure.subject,
    severity: "blocking",
    evidence: failure.evidence,
  }));
  for (const entry of loaded.entries) {
    const record = await consumedOutputRecordFromJson({
      value: entry.value,
      ledgerPath: entry.ledgerPath,
      source: input.source,
    });
    if (!record) {
      if (hasTerminalOutputIntent(entry.value)) {
        debt.push({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
          subject: entry.ledgerPath,
          severity: "blocking",
          evidence: [
            "terminal consumed-output record has an unknown or invalid status",
          ],
        });
      }
      continue;
    }
    if (!record.valid) {
      debt.push({
        reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
        subject: entry.ledgerPath,
        severity: "blocking",
        evidence: record.evidence,
      });
    }
    setLatestRecord(byJobId, record.jobId, record);
    if (
      record.status !== NO_OUTPUT_STATUS &&
      record.status !== REVIEWED_NO_CHANGE_STATUS &&
      record.workspace
    ) {
      setLatestRecord(byWorkspace, resolve(record.workspace), record);
    }
    if (
      record.status !== NO_OUTPUT_STATUS &&
      record.status !== REVIEWED_NO_CHANGE_STATUS &&
      record.resolvedWorkspace
    ) {
      setLatestRecord(byWorkspace, record.resolvedWorkspace, record);
    }
  }
  return { byJobId, byWorkspace, debt };
}

function hasTerminalOutputIntent(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.jobId === "string" &&
    value.jobId.length > 0 &&
    typeof value.status === "string" &&
    value.status.length > 0;
}

function setLatestRecord(
  records: Map<string, ConsumedOutputRecord>,
  key: string,
  candidate: ConsumedOutputRecord,
): void {
  const current = records.get(key);
  if (!current || compareConsumedRecords(candidate, current) > 0) {
    records.set(key, candidate);
  }
}

function compareConsumedRecords(
  left: ConsumedOutputRecord,
  right: ConsumedOutputRecord,
): number {
  const leftTime = left.closedAt ? Date.parse(left.closedAt) : Number.NEGATIVE_INFINITY;
  const rightTime = right.closedAt
    ? Date.parse(right.closedAt)
    : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.ledgerPath.localeCompare(right.ledgerPath);
}

export async function consumedOutputRecordFromJson(input: {
  readonly value: unknown;
  readonly ledgerPath: string;
  readonly source: Pick<
    ConsumedOutputLedgerSourcePort,
    "pathExists" | "pathSize" | "pathSha256" | "resolveWorkspacePath"
  >;
}): Promise<ConsumedOutputRecord | null> {
  if (!isRecord(input.value)) return null;
  const status = stringValue(input.value.status);
  if (!status || !CONSUMED_OUTPUT_TERMINAL_STATUSES.has(status)) return null;
  const jobId = stringValue(input.value.jobId);
  if (!jobId) {
    return {
      jobId: basename(input.ledgerPath).replace(/\.json$/, ""),
      status,
      ledgerPath: input.ledgerPath,
      hasAuthoredOutput: false,
      valid: false,
      evidence: ["terminal consumed-output record is missing jobId"],
    };
  }
  const evidence: string[] = [];
  const backup = isRecord(input.value.backup) ? input.value.backup : undefined;
  const workspace = backup ? stringValue(backup.workspace) : undefined;
  const terminalBackup = terminalOutputBackup(backup);
  const attemptId = stringValue(input.value.attemptId);
  const closedAt = stringValue(input.value.closedAt);
  const hasActiveClaim = isRecord(input.value.claim) ||
    input.value.active === true || input.value.claimed === true;
  if (!closedAt) evidence.push("terminal consumed-output record is missing closedAt");
  if (closedAt && !Number.isFinite(Date.parse(closedAt))) {
    evidence.push("terminal consumed-output record has invalid closedAt");
  }
  if (!backup) evidence.push("terminal consumed-output record is missing backup");
  if (!workspace) evidence.push("terminal consumed-output backup is missing workspace");
  if (isRecord(input.value.claim)) {
    evidence.push("terminal consumed-output record still has active claim");
  }
  if (input.value.active === true || input.value.claimed === true) {
    evidence.push("terminal consumed-output record is still marked active/claimed");
  }
  const backupEvidence = backup
    ? await consumedOutputBackupEvidence(backup, input.source)
    : {
      ok: false,
      hasAuthoredOutput: false,
      workspaceDirty: false,
      evidence: ["backup metadata is missing"],
    };
  const preexistingWorkspacePatch = await preexistingWorkspacePatchEvidence(
    input.value,
    input.source,
  );
  evidence.push(...preexistingWorkspacePatch.evidence);
  evidence.push(...backupEvidence.evidence);
  const commit = integratedOutputCommit(input.value);
  const hasAuthoredOutput = backupEvidence.hasAuthoredOutput ||
    (status === "integrated" && commit !== undefined);
  if (status === NO_OUTPUT_STATUS) {
    evidence.push(...failedNoOutputEvidence(
      input.value,
      hasAuthoredOutput,
      backupEvidence.workspaceDirty,
      preexistingWorkspacePatch.valid,
    ));
  } else if (status === REVIEWED_NO_CHANGE_STATUS) {
    evidence.push(...reviewedNoChangeEvidence(input.value, hasAuthoredOutput));
  } else if (!hasAuthoredOutput) {
    evidence.push(
      `terminal output status ${status} has no authored output evidence; use failed_no_output for infrastructure failures`,
    );
  }
  if (status === "integrated" && !commit) {
    evidence.push("integrated consumed-output record is missing commit evidence");
  }
  const resolvedWorkspace = workspace
    ? await input.source.resolveWorkspacePath(workspace)
    : undefined;
  const reclassifiableAsFailedNoOutput = Boolean(
    closedAt &&
      terminalBackup &&
      !hasActiveClaim &&
      backupEvidence.ok &&
      !backupEvidence.hasAuthoredOutput &&
      !backupEvidence.workspaceDirty,
  );
  return {
    jobId,
    ...(attemptId ? { attemptId } : {}),
    status,
    ledgerPath: input.ledgerPath,
    ...(closedAt ? { closedAt } : {}),
    ...(workspace ? { workspace } : {}),
    ...(resolvedWorkspace ? { resolvedWorkspace } : {}),
    ...(commit ? { commitSha: commit } : {}),
    ...(terminalBackup ? { backup: terminalBackup } : {}),
    ...(backupEvidence.patchSha256
      ? { backupPatchSha256: backupEvidence.patchSha256 }
      : {}),
    backupEvidenceValid: backupEvidence.ok,
    backupWorkspaceDirty: backupEvidence.workspaceDirty,
    preexistingWorkspacePatchValid: preexistingWorkspacePatch.valid,
    reclassifiableAsFailedNoOutput,
    hasAuthoredOutput,
    valid: evidence.length === 0,
    evidence: evidence.length === 0
      ? consumedOutputEvidence({
          status,
          ledgerPath: input.ledgerPath,
          ...(commit ? { commitSha: commit } : {}),
        })
      : evidence,
  };
}

export function consumedOutputRecordFor(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly jobId: string;
  readonly workspacePath?: string;
  readonly resolvedWorkspacePath?: string;
}): ConsumedOutputRecord | undefined {
  const workspace = input.workspacePath ? resolve(input.workspacePath) : undefined;
  const resolvedWorkspace = input.resolvedWorkspacePath
    ? resolve(input.resolvedWorkspacePath)
    : undefined;
  const byJob = input.ledger.byJobId.get(input.jobId);
  if (byJob) {
    if (
      workspace &&
      byJob.workspace &&
      resolve(byJob.workspace) !== workspace &&
      resolve(byJob.workspace) !== resolvedWorkspace &&
      byJob.resolvedWorkspace !== workspace &&
      byJob.resolvedWorkspace !== resolvedWorkspace
    ) {
      return {
        ...byJob,
        valid: false,
        evidence: [
          ...byJob.evidence,
          `ledger workspace ${byJob.workspace} does not match dirty workspace ${workspace}`,
        ],
      };
    }
    return byJob;
  }

  const byWorkspace = workspace
    ? input.ledger.byWorkspace.get(workspace)
    : undefined;
  const byResolvedWorkspace = resolvedWorkspace
    ? input.ledger.byWorkspace.get(resolvedWorkspace)
    : undefined;
  const workspaceRecord = byWorkspace ?? byResolvedWorkspace;
  if (workspaceRecord) {
    if (workspaceRecord.jobId !== input.jobId) {
      return {
        ...workspaceRecord,
        valid: false,
        evidence: [
          ...workspaceRecord.evidence,
          `ledger jobId ${workspaceRecord.jobId} does not match dirty jobId ${input.jobId}`,
        ],
      };
    }
    return workspaceRecord;
  }
  return undefined;
}

export function consumedDebt(record: ConsumedOutputRecord): readonly ProjectDebtItem[] {
  if (record.status === NO_OUTPUT_STATUS && record.valid) return [];
  return [{
    reason: record.valid
      ? ProjectDebtReason.ConsumedDirtyWorkspace
      : ProjectDebtReason.IncompleteConsumedOutputRecord,
    subject: record.workspace ?? record.jobId,
    severity: record.valid ? "info" : "blocking",
    evidence: record.valid
      ? consumedOutputEvidence(record)
      : record.evidence,
  }];
}

export function projectAdmissionDebtCounts(
  debt: readonly ProjectDebtItem[],
): NonNullable<ProjectAdmissionSnapshot["counts"]> {
  const count = (reason: ProjectDebtReason) =>
    debt.filter((item) => item.reason === reason).length;
  return {
    inactiveDirtyWorkspaces: count(ProjectDebtReason.InactiveDirtyWorkspace),
    unconsumedCompletedJobs: count(ProjectDebtReason.UnconsumedCompletedJob),
    orphanLegacyWorkspaces: count(ProjectDebtReason.OrphanLegacyWorkspace),
    consumedDirtyWorkspaces: count(ProjectDebtReason.ConsumedDirtyWorkspace),
    incompleteConsumedOutputRecords: count(ProjectDebtReason.IncompleteConsumedOutputRecord),
    legacyOutputQuarantineRequired: count(
      ProjectDebtReason.LegacyOutputQuarantineRequired,
    ),
    activeWriterConflicts: count(ProjectDebtReason.ActiveWriterConflict),
    staleDirtyWorkers: count(ProjectDebtReason.StaleDirtyWorker),
    unreadableRoots: count(ProjectDebtReason.UnreadableRoot),
    unreadableWorkspaces: count(ProjectDebtReason.UnreadableWorkspace),
    diskPressure: count(ProjectDebtReason.DiskPressure),
  };
}

async function consumedOutputBackupEvidence(
  backup: Record<string, unknown>,
  source: Pick<
    ConsumedOutputLedgerSourcePort,
    "pathExists" | "pathSize" | "pathSha256"
  >,
): Promise<{
  readonly ok: boolean;
  readonly hasAuthoredOutput: boolean;
  readonly workspaceDirty: boolean;
  readonly patchSha256?: string;
  readonly evidence: readonly string[];
}> {
  const evidence: string[] = [];
  const statusPath = stringValue(backup.statusPath);
  let statusSize: number | undefined;
  if (!statusPath) {
    evidence.push("backup is missing statusPath");
  } else if (!await source.pathExists(statusPath)) {
    evidence.push(`backup statusPath is missing: ${statusPath}`);
  } else {
    statusSize = await source.pathSize(statusPath);
  }
  const payloadPaths = [
    stringValue(backup.patchPath),
    stringValue(backup.numstatPath),
    stringValue(backup.untrackedArchivePath),
  ].filter((path): path is string => typeof path === "string");
  if (payloadPaths.length === 0) {
    evidence.push("backup is missing patch/numstat/untracked archive evidence");
  }
  const payloadSizes = await Promise.all(
    payloadPaths.map(async (path) => await source.pathSize(path)),
  );
  const patchPath = stringValue(backup.patchPath);
  const patchSha256 = patchPath
    ? await source.pathSha256(patchPath)
    : undefined;
  if (payloadPaths.length > 0 && payloadSizes.every((size) => size === undefined)) {
      evidence.push("none of backup patch/numstat/untracked archive paths exists");
  }
  return {
    ok: evidence.length === 0,
    hasAuthoredOutput: payloadSizes.some((size) => size !== undefined && size > 0),
    workspaceDirty: statusSize !== undefined && statusSize > 0,
    ...(patchSha256 ? { patchSha256 } : {}),
    evidence,
  };
}

function failedNoOutputEvidence(
  value: Record<string, unknown>,
  hasAuthoredOutput: boolean,
  backupWorkspaceDirty: boolean,
  preexistingWorkspacePatchValid: boolean,
): readonly string[] {
  const evidence: string[] = [];
  const failure = isRecord(value.failure) ? value.failure : undefined;
  const output = isRecord(value.output) ? value.output : undefined;
  if (!failure || !stringValue(failure.code) || !stringValue(failure.category)) {
    evidence.push("failed_no_output record requires failure.code and failure.category");
  }
  if (!output || output.authoredChanges !== false || output.workspaceDirty !== false) {
    evidence.push(
      "failed_no_output record requires output.authoredChanges=false and output.workspaceDirty=false",
    );
  }
  if (hasAuthoredOutput) {
    evidence.push("failed_no_output record contradicts non-empty authored output evidence");
  }
  if (backupWorkspaceDirty && !preexistingWorkspacePatchValid) {
    evidence.push("failed_no_output record contradicts non-empty workspace status evidence");
  }
  return evidence;
}

async function preexistingWorkspacePatchEvidence(
  value: Record<string, unknown>,
  source: Pick<ConsumedOutputLedgerSourcePort, "pathSize" | "pathSha256">,
): Promise<{ readonly valid: boolean; readonly evidence: readonly string[] }> {
  const candidate = isRecord(value.preexistingWorkspacePatch)
    ? value.preexistingWorkspacePatch
    : undefined;
  if (!candidate) return { valid: false, evidence: [] };
  const path = stringValue(candidate.path);
  const expectedSha256 = stringValue(candidate.sha256)?.toLowerCase();
  if (!path || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    return {
      valid: false,
      evidence: ["preexisting workspace patch metadata is invalid"],
    };
  }
  const backup = isRecord(value.backup) ? value.backup : undefined;
  const statusPath = backup ? stringValue(backup.statusPath) : undefined;
  if (!statusPath || !pathInsideOrEqual(path, dirname(statusPath))) {
    return {
      valid: false,
      evidence: ["preexisting workspace patch is outside terminal backup"],
    };
  }
  // The scoped command verifies payload bytes before publishing the immutable
  // decision. Admission readers only inspect metadata and never open payloads.
  const size = await source.pathSize(path);
  if (size === undefined || size <= 0) {
    return {
      valid: false,
      evidence: [`preexisting workspace patch is missing or empty: ${path}`],
    };
  }
  const actualSha256 = await source.pathSha256(path);
  if (actualSha256 !== expectedSha256) {
    return {
      valid: false,
      evidence: [`preexisting workspace patch hash mismatch: ${path}`],
    };
  }
  return { valid: true, evidence: [] };
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const pathRelative = relative(resolve(root), resolve(path));
  return pathRelative === "" ||
    (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`));
}

function terminalOutputBackup(
  value: Record<string, unknown> | undefined,
): TerminalOutputBackup | undefined {
  if (!value) return undefined;
  const workspace = stringValue(value.workspace);
  const statusPath = stringValue(value.statusPath);
  if (!workspace || !statusPath) return undefined;
  const patchPath = stringValue(value.patchPath);
  const numstatPath = stringValue(value.numstatPath);
  const untrackedArchivePath = stringValue(value.untrackedArchivePath);
  return {
    workspace,
    statusPath,
    ...(patchPath ? { patchPath } : {}),
    ...(numstatPath ? { numstatPath } : {}),
    ...(untrackedArchivePath ? { untrackedArchivePath } : {}),
  };
}

function reviewedNoChangeEvidence(
  value: Record<string, unknown>,
  hasAuthoredOutput: boolean,
): readonly string[] {
  const evidence: string[] = [];
  if (stringValue(value.outcome) !== REVIEWED_NO_CHANGE_STATUS) {
    evidence.push("reviewed_no_change record requires outcome=reviewed_no_change");
  }
  if (hasAuthoredOutput) {
    evidence.push("reviewed_no_change record contradicts non-empty authored output evidence");
  }
  return evidence;
}

function integratedOutputCommit(value: Record<string, unknown>): string | undefined {
  for (const key of ["commitSha", "commit", "integratedCommitSha"]) {
    const topLevelCommit = stringValue(value[key]);
    if (topLevelCommit && /^[0-9a-f]{7,40}$/i.test(topLevelCommit)) {
      return topLevelCommit;
    }
  }
  const notes = Array.isArray(value.notes) ? value.notes : [];
  for (const note of notes) {
    if (!isRecord(note)) continue;
    const commit = stringValue(note.commit);
    if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) return commit;
  }
  return undefined;
}

function consumedOutputEvidence(input: {
  readonly status: string;
  readonly ledgerPath: string;
  readonly commitSha?: string;
}): readonly string[] {
  if (input.status === NO_OUTPUT_STATUS) {
    return [
      "terminal job recorded with no authored output",
      `ledger: ${input.ledgerPath}`,
    ];
  }
  return [
    `dirty output consumed by terminal ledger status: ${input.status}`,
    `ledger: ${input.ledgerPath}`,
    ...(input.commitSha ? [`commit: ${input.commitSha}`] : []),
  ];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
