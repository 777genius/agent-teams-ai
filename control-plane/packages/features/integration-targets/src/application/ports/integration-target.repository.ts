import type {
  DesktopClientId,
  IntegrationConnectionId,
  UnixMilliseconds,
  WorkspaceId,
} from "@agent-teams-control-plane/shared";

import type {
  IntegrationTarget,
  IntegrationTargetId,
  RepositoryTargetBinding,
  TargetPolicyRule,
  TargetPolicyRuleInput,
  TargetPolicySubjectKind,
} from "../../domain/integration-target.js";
import type { TransactionContext } from "./transaction-runner.js";

export type RepositoryAvailabilityView = Readonly<{
  availabilitySnapshotId: string;
  providerRepositoryId: string;
  displayOwner: string;
  displayName: string;
  displayFullName: string;
  private: boolean;
  archived: boolean;
  available: boolean;
  lastVerifiedAtMs: UnixMilliseconds;
  target?: IntegrationTarget;
}>;

export type RepositorySyncView = Readonly<{
  complete: boolean;
  nextCursor?: string;
}>;

export type AvailableRepositoryTargetsView = Readonly<{
  connection: Readonly<{
    id: IntegrationConnectionId;
    workspaceId: WorkspaceId;
    provider: "github";
    providerInstallationId: string;
    status: "active" | "suspended" | "deleted";
    repositorySyncStatus: RepositorySyncView;
  }>;
  repositories: readonly RepositoryAvailabilityView[];
}>;

export type RepositoryTargetView = Readonly<{
  target: IntegrationTarget;
  binding: RepositoryTargetBinding;
  policyRules: readonly TargetPolicyRule[];
}>;

export type EnableRepositoryTargetRepositoryInput = Readonly<{
  workspaceId: WorkspaceId;
  desktopClientId: DesktopClientId;
  integrationConnectionId: IntegrationConnectionId;
  githubRepositoryId: string;
  initialPolicyRules: readonly TargetPolicyRuleInput[];
  initialPolicyRulesProvided: boolean;
  repositoryAvailabilityMaxAgeMs: number;
  nowMs: UnixMilliseconds;
}>;

export type ReplaceTargetPolicyRepositoryInput = Readonly<{
  workspaceId: WorkspaceId;
  desktopClientId: DesktopClientId;
  targetId: IntegrationTargetId;
  expectedPolicyVersion: number;
  policyRules: readonly TargetPolicyRuleInput[];
  nowMs: UnixMilliseconds;
}>;

export type DisableRepositoryTargetRepositoryInput = Readonly<{
  workspaceId: WorkspaceId;
  targetId: IntegrationTargetId;
  reason?: string;
  nowMs: UnixMilliseconds;
}>;

export type EvaluateTargetPolicyRepositoryInput = Readonly<{
  workspaceId: WorkspaceId;
  targetId: IntegrationTargetId;
  capability: string;
  subjectKind: TargetPolicySubjectKind;
  subjectId: string;
  desktopClientSubjectId?: string;
  teamSubjectId?: string;
  agentSubjectId?: string;
  repositoryAvailabilityMaxAgeMs: number;
  nowMs: UnixMilliseconds;
}>;

export type TargetPolicyEvaluationView = Readonly<{
  allowed: boolean;
  reasonCode: string;
  policyVersion: number;
}>;

export type RepositoryTargetPagination = Readonly<{
  limit: number;
  offset: number;
}>;

export interface IntegrationTargetRepository {
  listAvailableRepositories(input: {
    workspaceId: WorkspaceId;
    integrationConnectionId: IntegrationConnectionId;
    filters?: {
      available?: boolean;
      archived?: boolean;
      targetStatus?: string;
    };
    pagination?: RepositoryTargetPagination;
  }): Promise<AvailableRepositoryTargetsView>;
  listTargets(input: {
    workspaceId: WorkspaceId;
    status?: string;
    pagination?: RepositoryTargetPagination;
  }): Promise<readonly RepositoryTargetView[]>;
  findTarget(input: {
    workspaceId: WorkspaceId;
    targetId: IntegrationTargetId;
  }): Promise<RepositoryTargetView | undefined>;
  enableRepositoryTarget(
    input: EnableRepositoryTargetRepositoryInput,
    context: TransactionContext,
  ): Promise<RepositoryTargetView>;
  disableTarget(
    input: DisableRepositoryTargetRepositoryInput,
    context: TransactionContext,
  ): Promise<RepositoryTargetView>;
  replacePolicy(
    input: ReplaceTargetPolicyRepositoryInput,
    context: TransactionContext,
  ): Promise<RepositoryTargetView>;
  evaluatePolicy(
    input: EvaluateTargetPolicyRepositoryInput,
  ): Promise<TargetPolicyEvaluationView>;
}
