import { createSafeError } from "@agent-teams-control-plane/shared";

import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";

import type { TransactionContext } from "./transaction-runner.js";

export type IntegrationTargetsFeature = "integration-targets";

export interface IntegrationTargetsFeatureGatePolicy {
  assertEnabled(feature: IntegrationTargetsFeature): Promise<void>;
}

export interface IntegrationTargetsSettings {
  repositoryAvailabilityMaxAgeMs(): number;
}

export interface IntegrationTargetsAuditLog {
  record(
    input: {
      eventType: string;
      actor?: DesktopClientActor;
      workspaceId?: string;
      subjectKind?: string;
      subjectId?: string;
      safeMetadata?: Readonly<Record<string, boolean | number | string | null>>;
    },
    context?: TransactionContext,
  ): Promise<void>;
}

export function integrationTargetsFeatureDisabledError(
  feature: IntegrationTargetsFeature,
) {
  return createSafeError({
    category: "authorization",
    code: "CONTROL_PLANE_FEATURE_DISABLED",
    message: "Control-plane feature is disabled.",
    safeDetails: { feature },
  });
}
