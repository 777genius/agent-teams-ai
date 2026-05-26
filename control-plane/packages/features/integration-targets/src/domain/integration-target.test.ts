import { describe, expect, it } from "vitest";

import {
  parseDesktopClientId,
  parseIntegrationConnectionId,
  parseWorkspaceId,
  toUnixMilliseconds,
} from "@agent-teams-control-plane/shared";

import {
  canonicalTargetPolicyFingerprint,
  normalizeTargetPolicySubjectId,
  parseIntegrationTargetId,
  parseTargetPolicyRuleId,
  validateTargetPolicyRules,
  type IntegrationTarget,
  type TargetPolicyRule,
  type TargetPolicyRuleInput,
} from "./integration-target.js";
import { evaluateTargetPolicy } from "./policy-evaluator.js";

describe("integration target policy domain", () => {
  it("rejects opaque subject ids without the required namespace prefix", () => {
    expect(() =>
      normalizeTargetPolicySubjectId({
        subjectId: "agent-1",
        subjectKind: "agent",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTROL_PLANE_TARGET_POLICY_SUBJECT_ID_INVALID",
      }),
    );
  });

  it("rejects namespace-only subject ids", () => {
    expect(() =>
      normalizeTargetPolicySubjectId({
        subjectId: "agent:",
        subjectKind: "agent",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTROL_PLANE_TARGET_POLICY_SUBJECT_ID_INVALID",
      }),
    );
  });

  it("rejects subject ids with unsafe characters", () => {
    expect(() =>
      normalizeTargetPolicySubjectId({
        subjectId: "agent:reviewer/../../secret",
        subjectKind: "agent",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTROL_PLANE_TARGET_POLICY_SUBJECT_ID_INVALID",
      }),
    );
  });

  it("builds a stable canonical fingerprint from sorted normalized policy rules", () => {
    const rulesA: readonly TargetPolicyRuleInput[] = [
      {
        capability: "github.pr_review.request",
        effect: "deny",
        subjectId: "agent:reviewer",
        subjectKind: "agent",
      },
      {
        capability: "github.issue_comment.request",
        effect: "allow",
        subjectId: " workspace:workspace-1 ",
        subjectKind: "workspace",
      },
    ];
    const rulesB: readonly TargetPolicyRuleInput[] = [...rulesA].reverse();

    expect(canonicalTargetPolicyFingerprint(rulesA)).toBe(
      canonicalTargetPolicyFingerprint(rulesB),
    );
  });

  it("detects duplicate policy rules after normalization", () => {
    const error = validateTargetPolicyRules([
      {
        capability: "github.issue_comment.request",
        effect: "allow",
        subjectId: "workspace:workspace-1",
        subjectKind: "workspace",
      },
      {
        capability: "github.issue_comment.request",
        effect: "allow",
        subjectId: " workspace:workspace-1 ",
        subjectKind: "workspace",
      },
    ]);

    expect(error).toMatchObject({
      code: "CONTROL_PLANE_TARGET_POLICY_RULE_DUPLICATE",
    });
  });

  it("denies disabled targets before evaluating matching policy rules", () => {
    const result = evaluateTargetPolicy({
      capability: "github.issue_comment.request",
      rules: [
        policyRule({
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        }),
      ],
      subjectId: "workspace:workspace-1",
      subjectKind: "workspace",
      target: target({ status: "disabled" }),
      workspaceSubjectId: "workspace:workspace-1",
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_TARGET_DISABLED",
    });
  });

  it("denies stale targets with a stale-specific reason", () => {
    const result = evaluateTargetPolicy({
      capability: "github.issue_comment.request",
      rules: [
        policyRule({
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        }),
      ],
      subjectId: "workspace:workspace-1",
      subjectKind: "workspace",
      target: target({ status: "stale" }),
      workspaceSubjectId: "workspace:workspace-1",
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_TARGET_STALE",
    });
  });

  it("lets explicit deny win over a broader allow", () => {
    const result = evaluateTargetPolicy({
      agentSubjectId: "agent:reviewer",
      capability: "github.pr_comment.request",
      rules: [
        policyRule({
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        }),
        policyRule({
          effect: "deny",
          subjectId: "agent:reviewer",
          subjectKind: "agent",
        }),
      ],
      subjectId: "agent:reviewer",
      subjectKind: "agent",
      target: target(),
      workspaceSubjectId: "workspace:workspace-1",
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_EXPLICIT_DENY",
    });
  });

  it("allows only when at least one matching allow exists", () => {
    const allowed = evaluateTargetPolicy({
      capability: "github.check_run.request",
      rules: [
        policyRule({
          capability: "github.check_run.request",
          effect: "allow",
          subjectId: "desktop-client:desktop-1",
          subjectKind: "desktop_client",
        }),
      ],
      subjectId: "desktop-client:desktop-1",
      subjectKind: "desktop_client",
      target: target(),
      workspaceSubjectId: "workspace:workspace-1",
    });
    const denied = evaluateTargetPolicy({
      capability: "github.pr_review.request",
      rules: [],
      subjectId: "agent:reviewer",
      subjectKind: "agent",
      target: target(),
      workspaceSubjectId: "workspace:workspace-1",
    });

    expect(allowed).toMatchObject({
      allowed: true,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_ALLOWED",
    });
    expect(denied).toMatchObject({
      allowed: false,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_NO_MATCHING_ALLOW",
    });
  });

  it("denies unknown capabilities by default", () => {
    const result = evaluateTargetPolicy({
      capability: "github.unknown.request",
      rules: [
        policyRule({
          capability: "github.issue_comment.request",
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        }),
      ],
      subjectId: "workspace:workspace-1",
      subjectKind: "workspace",
      target: target(),
      workspaceSubjectId: "workspace:workspace-1",
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_CAPABILITY_DENIED",
    });
  });

  it("matches the primary subject without duplicated optional subject ids", () => {
    const result = evaluateTargetPolicy({
      capability: "github.pr_review.request",
      rules: [
        policyRule({
          capability: "github.pr_review.request",
          effect: "allow",
          subjectId: "agent:reviewer",
          subjectKind: "agent",
        }),
      ],
      subjectId: "agent:reviewer",
      subjectKind: "agent",
      target: target(),
      workspaceSubjectId: "workspace:workspace-1",
    });

    expect(result).toMatchObject({
      allowed: true,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_ALLOWED",
    });
  });
});

function target(overrides: Partial<IntegrationTarget> = {}): IntegrationTarget {
  return {
    createdAtMs: toUnixMilliseconds(0),
    displayName: "octo/repo",
    id: parseTargetId("target-1"),
    integrationConnectionId: parseConnectionId("connection-1"),
    policyVersion: 1,
    provider: "github",
    providerTargetId: "repo-1",
    status: "enabled",
    targetKind: "github_repository",
    updatedAtMs: toUnixMilliseconds(0),
    workspaceId: parseWorkspace("workspace-1"),
    ...overrides,
  };
}

function policyRule(overrides: Partial<TargetPolicyRule> = {}): TargetPolicyRule {
  return {
    capability: "github.pr_comment.request",
    createdAtMs: toUnixMilliseconds(0),
    createdByDesktopClientId: parseDesktop("desktop-1"),
    effect: "allow",
    id: parsePolicyRuleId("rule-1"),
    integrationTargetId: parseTargetId("target-1"),
    subjectId: "workspace:workspace-1",
    subjectKind: "workspace",
    workspaceId: parseWorkspace("workspace-1"),
    ...overrides,
  };
}

function parseWorkspace(value: string) {
  const result = parseWorkspaceId(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function parseDesktop(value: string) {
  const result = parseDesktopClientId(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function parseConnectionId(value: string) {
  const result = parseIntegrationConnectionId(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function parseTargetId(value: string) {
  return parseIntegrationTargetId(value);
}

function parsePolicyRuleId(value: string) {
  return parseTargetPolicyRuleId(value);
}
