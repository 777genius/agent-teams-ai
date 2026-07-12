import type { IntegrationAttempt } from "../domain/integration-attempt";

export type IntegratedOutputLedgerPreparation = {
  readonly attemptId: string;
  readonly workerJobId: string;
  readonly workerWorkspacePath: string;
  readonly commitSha: string;
  readonly archivePath: string;
  readonly statusPath: string;
  readonly patchPath: string;
  readonly numstatPath: string;
};

export type IntegratedOutputLedgerReceipt = {
  readonly ledgerPath: string;
  readonly archivePath: string;
  readonly commitSha: string;
  readonly idempotentReplay: boolean;
};

export type RejectedOutputLedgerPreparation = {
  readonly attemptId: string;
  readonly workerJobId: string;
  readonly workerWorkspacePath: string;
  readonly archivePath: string;
  readonly statusPath: string;
  readonly patchPath: string;
  readonly numstatPath: string;
  readonly hasAuthoredOutput: boolean;
};

export type RejectedOutputLedgerReceipt = {
  readonly ledgerPath: string;
  readonly archivePath: string;
  readonly status: "rejected" | "failed_no_output";
  readonly idempotentReplay: boolean;
};

export interface IntegratedOutputLedgerPort {
  prepare(input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }): Promise<IntegratedOutputLedgerPreparation>;

  finalize(input: {
    readonly preparation: IntegratedOutputLedgerPreparation;
    readonly pushedAt: string;
  }): Promise<IntegratedOutputLedgerReceipt>;

  prepareRejection(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<RejectedOutputLedgerPreparation>;

  finalizeRejection(input: {
    readonly preparation: RejectedOutputLedgerPreparation;
    readonly rejectedAt: string;
    readonly reason: string;
  }): Promise<RejectedOutputLedgerReceipt>;
}
