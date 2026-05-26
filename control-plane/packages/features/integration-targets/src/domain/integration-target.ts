import {
  createSafeError,
  parseOpaqueId,
  type DesktopClientId,
  type IntegrationConnectionId,
  type OpaqueId,
  type SafeError,
  type UnixMilliseconds,
  type WorkspaceId,
} from "@agent-teams-control-plane/shared";

export type IntegrationTargetId = OpaqueId<"IntegrationTargetId">;
export type RepositoryTargetBindingId = OpaqueId<"RepositoryTargetBindingId">;
export type TargetPolicyRuleId = OpaqueId<"TargetPolicyRuleId">;

export type IntegrationTargetProvider = "github";
export type IntegrationTargetKind = "github_repository";
export type IntegrationTargetStatus =
  | "enabled"
  | "disabled"
  | "stale"
  | "revoked"
  | "deleted";

export type TargetPolicySubjectKind = "workspace" | "team" | "agent" | "desktop_client";
export type TargetPolicyCapability =
  | "github.issue_comment.request"
  | "github.pr_comment.request"
  | "github.pr_review.request"
  | "github.check_run.request";
export type TargetPolicyEffect = "allow" | "deny";

export type IntegrationTarget = Readonly<{
  id: IntegrationTargetId;
  workspaceId: WorkspaceId;
  integrationConnectionId: IntegrationConnectionId;
  provider: IntegrationTargetProvider;
  targetKind: IntegrationTargetKind;
  providerTargetId: string;
  displayName: string;
  status: IntegrationTargetStatus;
  policyVersion: number;
  createdAtMs: UnixMilliseconds;
  updatedAtMs: UnixMilliseconds;
  staleAtMs?: UnixMilliseconds;
  disabledAtMs?: UnixMilliseconds;
  deletedAtMs?: UnixMilliseconds;
}>;

export type RepositoryTargetBinding = Readonly<{
  id: RepositoryTargetBindingId;
  integrationTargetId: IntegrationTargetId;
  githubInstallationId: string;
  githubRepositoryId: string;
  githubNodeId?: string;
  displayOwner: string;
  displayName: string;
  displayFullName: string;
  private: boolean;
  archived: boolean;
  lastVerifiedAtMs: UnixMilliseconds;
  repositoryAvailabilitySnapshotId?: string;
}>;

export type TargetPolicyRule = Readonly<{
  id: TargetPolicyRuleId;
  workspaceId: WorkspaceId;
  integrationTargetId: IntegrationTargetId;
  subjectKind: TargetPolicySubjectKind;
  subjectId: string;
  capability: TargetPolicyCapability;
  effect: TargetPolicyEffect;
  createdAtMs: UnixMilliseconds;
  createdByDesktopClientId: DesktopClientId;
}>;

export type TargetPolicyRuleInput = Readonly<{
  subjectKind: TargetPolicySubjectKind;
  subjectId: string;
  capability: TargetPolicyCapability;
  effect: TargetPolicyEffect;
}>;

export const TARGET_POLICY_CAPABILITIES = [
  "github.issue_comment.request",
  "github.pr_comment.request",
  "github.pr_review.request",
  "github.check_run.request",
] as const satisfies readonly TargetPolicyCapability[];

const TARGET_POLICY_SUBJECT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function parseIntegrationTargetId(value: unknown): IntegrationTargetId {
  const result = parseOpaqueId("IntegrationTargetId", value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function parseRepositoryTargetBindingId(
  value: unknown,
): RepositoryTargetBindingId {
  const result = parseOpaqueId("RepositoryTargetBindingId", value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function parseTargetPolicyRuleId(value: unknown): TargetPolicyRuleId {
  const result = parseOpaqueId("TargetPolicyRuleId", value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function assertTargetPolicyCapability(value: unknown): TargetPolicyCapability {
  if (isTargetPolicyCapability(value)) {
    return value;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_TARGET_POLICY_CAPABILITY_INVALID",
    message: "Target policy capability is not supported.",
  });
}

export function assertTargetPolicyEffect(value: unknown): TargetPolicyEffect {
  if (value === "allow" || value === "deny") {
    return value;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_TARGET_POLICY_EFFECT_INVALID",
    message: "Target policy effect is invalid.",
  });
}

export function assertTargetPolicySubjectKind(value: unknown): TargetPolicySubjectKind {
  if (
    value === "workspace" ||
    value === "team" ||
    value === "agent" ||
    value === "desktop_client"
  ) {
    return value;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_TARGET_POLICY_SUBJECT_KIND_INVALID",
    message: "Target policy subject kind is invalid.",
  });
}

export function assertIntegrationTargetStatus(value: unknown): IntegrationTargetStatus {
  if (
    value === "enabled" ||
    value === "disabled" ||
    value === "stale" ||
    value === "revoked" ||
    value === "deleted"
  ) {
    return value;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_INTEGRATION_TARGET_STATUS_INVALID",
    message: "Integration target status is invalid.",
  });
}

export function normalizeTargetPolicySubjectId(input: {
  subjectKind: TargetPolicySubjectKind;
  subjectId: unknown;
}): string {
  if (typeof input.subjectId !== "string") {
    throw invalidSubjectId();
  }
  const normalized = input.subjectId.trim();
  const expectedPrefix = expectedSubjectPrefix(input.subjectKind);
  if (
    normalized.length === 0 ||
    normalized.length <= expectedPrefix.length ||
    normalized.length > 256 ||
    !normalized.startsWith(expectedPrefix) ||
    !TARGET_POLICY_SUBJECT_ID_PATTERN.test(normalized) ||
    /\s/.test(normalized)
  ) {
    throw invalidSubjectId();
  }
  return normalized;
}

export function validateTargetPolicyRules(
  rules: readonly TargetPolicyRuleInput[],
): SafeError | undefined {
  const seen = new Set<string>();
  for (const rule of rules) {
    try {
      assertTargetPolicySubjectKind(rule.subjectKind);
      const subjectId = normalizeTargetPolicySubjectId({
        subjectId: rule.subjectId,
        subjectKind: rule.subjectKind,
      });
      assertTargetPolicyCapability(rule.capability);
      assertTargetPolicyEffect(rule.effect);
      const key = `${rule.subjectKind}:${subjectId}:${rule.capability}:${rule.effect}`;
      if (seen.has(key)) {
        return createSafeError({
          category: "validation",
          code: "CONTROL_PLANE_TARGET_POLICY_RULE_DUPLICATE",
          message: "Target policy contains duplicate rules.",
        });
      }
      seen.add(key);
    } catch (error) {
      if (isSafeErrorLike(error)) {
        return error;
      }
      throw error;
    }
  }
  return undefined;
}

export function canonicalTargetPolicyFingerprint(
  rules: readonly TargetPolicyRuleInput[],
): string {
  const normalized = rules
    .map((rule) => ({
      capability: assertTargetPolicyCapability(rule.capability),
      effect: assertTargetPolicyEffect(rule.effect),
      subjectId: normalizeTargetPolicySubjectId(rule),
      subjectKind: assertTargetPolicySubjectKind(rule.subjectKind),
    }))
    .sort(comparePolicyRuleInput);
  return JSON.stringify(normalized);
}

export function isTargetPolicyCapability(
  value: unknown,
): value is TargetPolicyCapability {
  return TARGET_POLICY_CAPABILITIES.some((capability) => capability === value);
}

function expectedSubjectPrefix(subjectKind: TargetPolicySubjectKind): string {
  if (subjectKind === "desktop_client") {
    return "desktop-client:";
  }
  return `${subjectKind}:`;
}

function invalidSubjectId(): SafeError {
  return createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_TARGET_POLICY_SUBJECT_ID_INVALID",
    message: "Target policy subject id is invalid.",
  });
}

function comparePolicyRuleInput(
  a: TargetPolicyRuleInput,
  b: TargetPolicyRuleInput,
): number {
  return (
    a.subjectKind.localeCompare(b.subjectKind) ||
    a.subjectId.localeCompare(b.subjectId) ||
    a.capability.localeCompare(b.capability) ||
    a.effect.localeCompare(b.effect)
  );
}

function isSafeErrorLike(error: unknown): error is SafeError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "category" in error &&
    "message" in error
  );
}
