import { resolve } from "node:path";

import type { ConsumedOutputRecord } from "./consumed-output-ledger";
import { recordTerminalOutputDecision } from "./record-terminal-output-decision";
import type {
  ConsumedOutputLedgerWriterPort,
  TerminalOutputDecisionReceipt,
} from "../ports/consumed-output-ledger-writer-port";

export type RecordFailedNoOutputInput = {
  readonly allowedLedgerRoots: readonly string[];
  readonly ledgerRoot: string;
  readonly sourceRecord: ConsumedOutputRecord;
  readonly jobId: string;
  readonly workspace: string;
  readonly workerAlive: boolean;
  readonly workspaceDirty: boolean | undefined;
  readonly attemptId: string;
  readonly closedAt: string;
  readonly failureCategory: string;
  readonly failureCode: string;
  readonly note: string;
  readonly preexistingWorkspacePatch?: {
    readonly path: string;
    readonly sha256: string;
  };
};

export async function recordFailedNoOutput(
  deps: { readonly writer: ConsumedOutputLedgerWriterPort },
  input: RecordFailedNoOutputInput,
): Promise<TerminalOutputDecisionReceipt> {
  assertFailedNoOutputEvidence(input);
  return await recordTerminalOutputDecision(deps, {
    allowedLedgerRoots: input.allowedLedgerRoots,
    ledgerRoot: input.ledgerRoot,
    decision: {
      schemaVersion: 1,
      jobId: input.jobId,
      attemptId: input.attemptId,
      status: "failed_no_output",
      closedAt: input.closedAt,
      failure: {
        category: input.failureCategory,
        code: input.failureCode,
      },
      output: {
        authoredChanges: false,
        workspaceDirty: false,
      },
      ...(input.preexistingWorkspacePatch
        ? { preexistingWorkspacePatch: input.preexistingWorkspacePatch }
        : {}),
      note: input.note,
      backup: input.sourceRecord.backup!,
    },
  });
}

export function assertFailedNoOutputEvidence(
  input: RecordFailedNoOutputInput,
): void {
  if (!input.attemptId.trim()) {
    throw new Error("failed_no_output_attempt_id_required");
  }
  if (!input.failureCategory.trim() || !input.failureCode.trim()) {
    throw new Error("failed_no_output_failure_required");
  }
  if (!input.note.trim()) throw new Error("failed_no_output_note_required");
  if (input.workerAlive) throw new Error("failed_no_output_worker_still_alive");
  if (input.workspaceDirty !== false && !input.preexistingWorkspacePatch) {
    throw new Error("failed_no_output_clean_workspace_required");
  }
  if (input.sourceRecord.jobId !== input.jobId) {
    throw new Error("failed_no_output_source_job_mismatch");
  }
  if (input.sourceRecord.valid) {
    throw new Error("failed_no_output_source_already_valid");
  }
  const baselineCorrection = Boolean(
    input.preexistingWorkspacePatch &&
      input.workspaceDirty === true &&
      input.sourceRecord.status === "failed_no_output" &&
      input.sourceRecord.backupWorkspaceDirty === true &&
      input.sourceRecord.evidence.every(
        (item) => item ===
          "failed_no_output record contradicts non-empty workspace status evidence",
      ),
  );
  if (
    (!baselineCorrection && input.sourceRecord.reclassifiableAsFailedNoOutput !== true) ||
    input.sourceRecord.backupEvidenceValid !== true ||
    input.sourceRecord.hasAuthoredOutput ||
    !input.sourceRecord.backup
  ) {
    throw new Error("failed_no_output_source_evidence_invalid");
  }
  if (resolve(input.sourceRecord.backup.workspace) !== resolve(input.workspace)) {
    throw new Error("failed_no_output_source_workspace_mismatch");
  }
  const sourceClosedAt = input.sourceRecord.closedAt
    ? Date.parse(input.sourceRecord.closedAt)
    : Number.NaN;
  const closedAt = Date.parse(input.closedAt);
  if (
    Number.isNaN(sourceClosedAt) ||
    Number.isNaN(closedAt) ||
    closedAt <= sourceClosedAt
  ) {
    throw new Error("failed_no_output_closed_at_must_follow_source");
  }
}
