import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

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
]);

export type ConsumedOutputRecord = {
  readonly jobId: string;
  readonly status: string;
  readonly ledgerPath: string;
  readonly closedAt?: string;
  readonly workspace?: string;
  readonly resolvedWorkspace?: string;
  readonly commitSha?: string;
  readonly valid: boolean;
  readonly evidence: readonly string[];
};

export type ConsumedOutputLedger = {
  readonly byJobId: ReadonlyMap<string, ConsumedOutputRecord>;
  readonly byWorkspace: ReadonlyMap<string, ConsumedOutputRecord>;
  readonly debt: readonly ProjectDebtItem[];
};

export async function readConsumedOutputLedgers(input: {
  readonly roots: readonly string[];
}): Promise<ConsumedOutputLedger> {
  const byJobId = new Map<string, ConsumedOutputRecord>();
  const byWorkspace = new Map<string, ConsumedOutputRecord>();
  const debt: ProjectDebtItem[] = [];
  for (const rootInput of uniqueStrings(input.roots)) {
    const root = resolve(rootInput);
    const itemsDir = join(root, "items");
    let entries;
    try {
      entries = await readdir(itemsDir, { withFileTypes: true });
    } catch (error) {
      debt.push({
        reason: ProjectDebtReason.UnreadableRoot,
        subject: itemsDir,
        severity: "blocking",
        evidence: [
          `consumed output ledger unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const ledgerPath = join(itemsDir, entry.name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
      } catch (error) {
        debt.push({
          reason: ProjectDebtReason.UnreadableRoot,
          subject: ledgerPath,
          severity: "blocking",
          evidence: [
            `consumed output ledger record unreadable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ],
        });
        continue;
      }
      const record = await consumedOutputRecordFromJson({
        value: parsed,
        ledgerPath,
      });
      if (!record) continue;
      byJobId.set(record.jobId, record);
      if (record.workspace) byWorkspace.set(resolve(record.workspace), record);
      if (record.resolvedWorkspace) {
        byWorkspace.set(record.resolvedWorkspace, record);
      }
    }
  }
  return { byJobId, byWorkspace, debt };
}

export async function consumedOutputRecordFromJson(input: {
  readonly value: unknown;
  readonly ledgerPath: string;
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
    ? await consumedOutputBackupEvidence(backup)
    : { ok: false, evidence: ["backup metadata is missing"] };
  evidence.push(...backupEvidence.evidence);
  const commit = integratedOutputCommit(input.value);
  if (status === "integrated" && !commit) {
    evidence.push("integrated consumed-output record is missing commit evidence");
  }
  let resolvedWorkspace: string | undefined;
  if (workspace) {
    try {
      resolvedWorkspace = await realpath(workspace);
    } catch {
      resolvedWorkspace = undefined;
    }
  }
  return {
    jobId,
    status,
    ledgerPath: input.ledgerPath,
    ...(closedAt ? { closedAt } : {}),
    ...(workspace ? { workspace } : {}),
    ...(resolvedWorkspace ? { resolvedWorkspace } : {}),
    ...(commit ? { commitSha: commit } : {}),
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
  const byJob = input.ledger.byJobId.get(input.jobId);
  if (!byJob) return undefined;
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

export function consumedDebt(record: ConsumedOutputRecord): readonly ProjectDebtItem[] {
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
): Promise<{ readonly ok: boolean; readonly evidence: readonly string[] }> {
  const evidence: string[] = [];
  const statusPath = stringValue(backup.statusPath);
  if (!statusPath) {
    evidence.push("backup is missing statusPath");
  } else if (!await pathExists(statusPath)) {
    evidence.push(`backup statusPath is missing: ${statusPath}`);
  }
  const payloadPaths = [
    stringValue(backup.patchPath),
    stringValue(backup.numstatPath),
    stringValue(backup.untrackedArchivePath),
  ].filter((path): path is string => typeof path === "string");
  if (payloadPaths.length === 0) {
    evidence.push("backup is missing patch/numstat/untracked archive evidence");
  } else {
    const existing = await Promise.all(
      payloadPaths.map(async (path) => await pathExists(path)),
    );
    if (!existing.some(Boolean)) {
      evidence.push("none of backup patch/numstat/untracked archive paths exists");
    }
  }
  return { ok: evidence.length === 0, evidence };
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
  return [
    `dirty output consumed by terminal ledger status: ${input.status}`,
    `ledger: ${input.ledgerPath}`,
    ...(input.commitSha ? [`commit: ${input.commitSha}`] : []),
  ];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
