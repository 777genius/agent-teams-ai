import { createSafeError, type SafeError } from "@agent-teams-control-plane/shared";

import {
  assertTargetPolicyCapability,
  normalizeTargetPolicySubjectId,
  type IntegrationTarget,
  type TargetPolicyRule,
  type TargetPolicySubjectKind,
} from "./integration-target.js";

export type TargetPolicyEvaluationInput = Readonly<{
  target: IntegrationTarget;
  rules: readonly TargetPolicyRule[];
  capability: string;
  subjectKind: TargetPolicySubjectKind;
  subjectId: string;
  workspaceSubjectId: string;
  desktopClientSubjectId?: string;
  teamSubjectId?: string;
  agentSubjectId?: string;
}>;

export type TargetPolicyEvaluationResult = Readonly<{
  allowed: boolean;
  reasonCode: string;
  policyVersion: number;
  safeError?: SafeError;
}>;

export function evaluateTargetPolicy(
  input: TargetPolicyEvaluationInput,
): TargetPolicyEvaluationResult {
  if (input.target.status !== "enabled") {
    return denyForTargetStatus(input.target.status, input.target.policyVersion);
  }

  try {
    assertTargetPolicyCapability(input.capability);
  } catch {
    return denied(
      input.target.policyVersion,
      "CONTROL_PLANE_TARGET_POLICY_CAPABILITY_DENIED",
      "Target policy capability is denied.",
    );
  }

  const subjectKeys = buildOrderedSubjectKeys(input);
  const matching = input.rules.filter(
    (rule) =>
      rule.capability === input.capability &&
      subjectKeys.has(`${rule.subjectKind}:${rule.subjectId}`),
  );
  const deniedRule = matching.find((rule) => rule.effect === "deny");
  if (deniedRule !== undefined) {
    return denied(
      input.target.policyVersion,
      "CONTROL_PLANE_TARGET_POLICY_EXPLICIT_DENY",
      "Target policy explicitly denies this action.",
    );
  }

  if (matching.some((rule) => rule.effect === "allow")) {
    return {
      allowed: true,
      policyVersion: input.target.policyVersion,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_ALLOWED",
    };
  }

  return denied(
    input.target.policyVersion,
    "CONTROL_PLANE_TARGET_POLICY_NO_MATCHING_ALLOW",
    "Target policy does not allow this action.",
  );
}

function buildOrderedSubjectKeys(
  input: TargetPolicyEvaluationInput,
): ReadonlySet<string> {
  const subjects: Array<{
    kind: TargetPolicySubjectKind;
    id: string | undefined;
  }> = [
    { id: input.workspaceSubjectId, kind: "workspace" },
    { id: input.desktopClientSubjectId, kind: "desktop_client" },
    { id: input.teamSubjectId, kind: "team" },
    { id: input.agentSubjectId, kind: "agent" },
    { id: input.subjectId, kind: input.subjectKind },
  ];

  return new Set(
    subjects.flatMap((subject) => {
      if (subject.id === undefined) {
        return [];
      }
      const subjectId = normalizeTargetPolicySubjectId({
        subjectId: subject.id,
        subjectKind: subject.kind,
      });
      return [`${subject.kind}:${subjectId}`];
    }),
  );
}

function denyForTargetStatus(
  status: IntegrationTarget["status"],
  policyVersion: number,
): TargetPolicyEvaluationResult {
  if (status === "disabled") {
    return denied(
      policyVersion,
      "CONTROL_PLANE_TARGET_POLICY_TARGET_DISABLED",
      "Target is disabled.",
    );
  }
  if (status === "stale") {
    return denied(
      policyVersion,
      "CONTROL_PLANE_TARGET_POLICY_TARGET_STALE",
      "Target is stale.",
    );
  }
  if (status === "revoked") {
    return denied(
      policyVersion,
      "CONTROL_PLANE_TARGET_POLICY_TARGET_REVOKED",
      "Target is revoked.",
    );
  }
  return denied(
    policyVersion,
    "CONTROL_PLANE_TARGET_POLICY_TARGET_DELETED",
    "Target is deleted.",
  );
}

function denied(
  policyVersion: number,
  code: string,
  message: string,
): TargetPolicyEvaluationResult {
  return {
    allowed: false,
    policyVersion,
    reasonCode: code,
    safeError: createSafeError({
      category: "authorization",
      code,
      message,
      safeDetails: { policyVersion },
    }),
  };
}
