import type { IntegrationAttempt } from "../domain/integration-attempt";
import type {
  OperatorArtifactRecoveryPermit,
  ValidatedOperatorArtifactRecovery,
} from "../domain/operator-artifact-recovery";

export enum OperatorArtifactRecoveryState {
  Ready = "ready",
  Prepared = "prepared",
  Completed = "completed",
}

export type OperatorArtifactRecoveryResult = {
  readonly state: OperatorArtifactRecoveryState;
  readonly permitSha256: string;
  readonly artifactArchivePath?: string;
  readonly preparedManifestPath?: string;
  readonly completedManifestPath?: string;
};

export interface OperatorArtifactRecoveryPort {
  inspect(input: {
    readonly attempt: IntegrationAttempt;
    readonly permit: OperatorArtifactRecoveryPermit;
    readonly permitSha256: string;
    readonly validation: ValidatedOperatorArtifactRecovery;
  }): Promise<OperatorArtifactRecoveryResult>;

  prepare(input: {
    readonly attempt: IntegrationAttempt;
    readonly permit: OperatorArtifactRecoveryPermit;
    readonly permitSha256: string;
    readonly validation: ValidatedOperatorArtifactRecovery;
    readonly preparedAt: string;
  }): Promise<OperatorArtifactRecoveryResult>;

  complete(input: {
    readonly attempt: IntegrationAttempt;
    readonly permit: OperatorArtifactRecoveryPermit;
    readonly permitSha256: string;
    readonly validation: ValidatedOperatorArtifactRecovery;
    readonly completedAt: string;
  }): Promise<OperatorArtifactRecoveryResult>;
}
