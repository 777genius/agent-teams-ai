export const TERMINAL_OUTPUT_STATUSES = [
  "integrated",
  "rejected",
  "duplicate",
  "superseded",
  "archived",
  "failed_no_output",
  "reviewed_no_change",
] as const;

export type TerminalOutputStatus = typeof TERMINAL_OUTPUT_STATUSES[number];

export type TerminalOutputBackup = {
  readonly workspace: string;
  readonly statusPath: string;
  readonly patchPath?: string;
  readonly numstatPath?: string;
  readonly untrackedArchivePath?: string;
};

export type TerminalOutputDecision = {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly attemptId?: string;
  readonly status: TerminalOutputStatus;
  readonly closedAt: string;
  readonly commitSha?: string;
  readonly archivePath?: string;
  readonly failure?: {
    readonly category: string;
    readonly code: string;
  };
  readonly output?: {
    readonly authoredChanges: boolean;
    readonly workspaceDirty: boolean;
  };
  readonly note: string;
  readonly backup: TerminalOutputBackup;
};

export function assertTerminalOutputDecision(
  decision: TerminalOutputDecision,
): TerminalOutputDecision {
  if (!decision.jobId.trim()) throw new Error("terminal_output_job_id_required");
  if (!TERMINAL_OUTPUT_STATUSES.includes(decision.status)) {
    throw new Error("terminal_output_status_invalid");
  }
  if (!decision.closedAt || Number.isNaN(Date.parse(decision.closedAt))) {
    throw new Error("terminal_output_closed_at_invalid");
  }
  if (!decision.note.trim()) throw new Error("terminal_output_note_required");
  if (!decision.backup.workspace || !decision.backup.statusPath) {
    throw new Error("terminal_output_backup_required");
  }
  if (decision.status === "integrated" && !decision.commitSha) {
    throw new Error("terminal_output_integrated_commit_required");
  }
  if (
    decision.status === "failed_no_output" &&
    (
      !decision.failure?.category ||
      !decision.failure.code ||
      decision.output?.authoredChanges !== false ||
      decision.output.workspaceDirty !== false
    )
  ) {
    throw new Error("terminal_output_failed_no_output_evidence_required");
  }
  return decision;
}
