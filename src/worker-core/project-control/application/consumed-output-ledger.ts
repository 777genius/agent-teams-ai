import { basename, resolve } from "node:path";

import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "../domain/project-admission";

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
  readonly status: string;
  readonly ledgerPath: string;
  readonly closedAt?: string;
  readonly workspace?: string;
  readonly resolvedWorkspace?: string;
  readonly commitSha?: string;
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
    if (!record) continue;
    byJobId.set(record.jobId, record);
    if (
      record.status !== NO_OUTPUT_STATUS &&
      record.status !== REVIEWED_NO_CHANGE_STATUS &&
      record.workspace
    ) {
      byWorkspace.set(resolve(record.workspace), record);
    }
    if (
      record.status !== NO_OUTPUT_STATUS &&
      record.status !== REVIEWED_NO_CHANGE_STATUS &&
      record.resolvedWorkspace
    ) {
      byWorkspace.set(record.resolvedWorkspace, record);
    }
  }
  return { byJobId, byWorkspace, debt };
}

export async function consumedOutputRecordFromJson(input: {
  readonly value: unknown;
  readonly ledgerPath: string;
  readonly source: Pick<
    ConsumedOutputLedgerSourcePort,
    "pathExists" | "pathSize" | "resolveWorkspacePath"
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
  const closedAt = stringValue(input.value.closedAt);
  if (!closedAt) evidence.push("terminal consumed-output record is missing closedAt");
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
      evidence: ["backup metadata is missing"],
    };
  evidence.push(...backupEvidence.evidence);
  const commit = integratedOutputCommit(input.value);
  const hasAuthoredOutput = backupEvidence.hasAuthoredOutput ||
    (status === "integrated" && commit !== undefined);
  if (status === NO_OUTPUT_STATUS) {
    evidence.push(...failedNoOutputEvidence(input.value, hasAuthoredOutput));
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
  return {
    jobId,
    status,
    ledgerPath: input.ledgerPath,
    ...(closedAt ? { closedAt } : {}),
    ...(workspace ? { workspace } : {}),
    ...(resolvedWorkspace ? { resolvedWorkspace } : {}),
    ...(commit ? { commitSha: commit } : {}),
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
  if (byJob?.status === NO_OUTPUT_STATUS) return undefined;
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
    activeWriterConflicts: count(ProjectDebtReason.ActiveWriterConflict),
    staleDirtyWorkers: count(ProjectDebtReason.StaleDirtyWorker),
    unreadableRoots: count(ProjectDebtReason.UnreadableRoot),
    unreadableWorkspaces: count(ProjectDebtReason.UnreadableWorkspace),
    diskPressure: count(ProjectDebtReason.DiskPressure),
  };
}

async function consumedOutputBackupEvidence(
  backup: Record<string, unknown>,
  source: Pick<ConsumedOutputLedgerSourcePort, "pathExists" | "pathSize">,
): Promise<{
  readonly ok: boolean;
  readonly hasAuthoredOutput: boolean;
  readonly evidence: readonly string[];
}> {
  const evidence: string[] = [];
  const statusPath = stringValue(backup.statusPath);
  if (!statusPath) {
    evidence.push("backup is missing statusPath");
  } else if (!await source.pathExists(statusPath)) {
    evidence.push(`backup statusPath is missing: ${statusPath}`);
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
  if (payloadPaths.length > 0 && payloadSizes.every((size) => size === undefined)) {
      evidence.push("none of backup patch/numstat/untracked archive paths exists");
  }
  return {
    ok: evidence.length === 0,
    hasAuthoredOutput: payloadSizes.some((size) => size !== undefined && size > 0),
    evidence,
  };
}

function failedNoOutputEvidence(
  value: Record<string, unknown>,
  hasAuthoredOutput: boolean,
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
  return evidence;
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
