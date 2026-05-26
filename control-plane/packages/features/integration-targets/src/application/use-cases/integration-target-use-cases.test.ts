import { describe, expect, it } from "vitest";

import type { DesktopClientActor } from "@agent-teams-control-plane/features-workspace-identity";
import {
  createSafeError,
  parseDesktopClientId,
  parseIntegrationConnectionId,
  parseWorkspaceId,
  toUnixMilliseconds,
  type TransactionContext,
} from "@agent-teams-control-plane/shared";

import {
  parseIntegrationTargetId,
  parseRepositoryTargetBindingId,
} from "../../domain/index.js";
import type {
  IntegrationTargetRepository,
  RepositoryTargetView,
} from "../ports/integration-target.repository.js";
import type {
  IntegrationTargetsAuditLog,
  IntegrationTargetsFeatureGatePolicy,
  IntegrationTargetsSettings,
} from "../ports/policies.js";
import { integrationTargetsFeatureDisabledError } from "../ports/policies.js";
import { DisableRepositoryTargetUseCase } from "./disable-repository-target.use-case.js";
import { EnableRepositoryTargetUseCase } from "./enable-repository-target.use-case.js";
import { EvaluateTargetPolicyUseCase } from "./evaluate-target-policy.use-case.js";
import { ListRepositoryTargetsUseCase } from "./list-repository-targets.use-case.js";
import { UpdateTargetPolicyUseCase } from "./update-target-policy.use-case.js";

describe("integration target use cases", () => {
  it("blocks target writes before entering transactions when the feature gate is disabled", async () => {
    let transactionCalls = 0;
    let repositoryCalls = 0;
    const useCase = new EnableRepositoryTargetUseCase(
      {
        enableRepositoryTarget: async () => {
          repositoryCalls += 1;
          throw new Error("not used");
        },
      } as unknown as IntegrationTargetRepository,
      {
        runInTransaction: async <T>(
          work: (context: TransactionContext) => Promise<T>,
        ) => {
          transactionCalls += 1;
          return work({ transactionId: "tx" } as TransactionContext);
        },
      },
      disabledFeatureGate(),
      settings(),
      auditLog(),
    );

    await expect(
      useCase.execute({
        actor: actor(),
        githubRepositoryId: "repo-1",
        integrationConnectionId: "connection-1",
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_FEATURE_DISABLED",
    });
    expect(transactionCalls).toBe(0);
    expect(repositoryCalls).toBe(0);
  });

  it("validates policy documents before replacing policy in persistence", async () => {
    let repositoryCalls = 0;
    const useCase = new UpdateTargetPolicyUseCase(
      {
        replacePolicy: async () => {
          repositoryCalls += 1;
          throw new Error("not used");
        },
      } as unknown as IntegrationTargetRepository,
      {
        runInTransaction: async <T>(work: (context: TransactionContext) => Promise<T>) =>
          work({ transactionId: "tx" } as TransactionContext),
      },
      enabledFeatureGate(),
      auditLog(),
    );

    await expect(
      useCase.execute({
        actor: actor(),
        expectedPolicyVersion: 1,
        policyRules: [
          {
            capability: "github.issue_comment.request",
            effect: "allow",
            subjectId: "agent-without-prefix",
            subjectKind: "agent",
          },
        ],
        targetId: "target-1",
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_TARGET_POLICY_SUBJECT_ID_INVALID",
    });
    expect(repositoryCalls).toBe(0);
  });

  it("rejects invalid expected policy versions before replacing policy", async () => {
    let repositoryCalls = 0;
    const useCase = new UpdateTargetPolicyUseCase(
      {
        replacePolicy: async () => {
          repositoryCalls += 1;
          throw new Error("not used");
        },
      } as unknown as IntegrationTargetRepository,
      {
        runInTransaction: async <T>(work: (context: TransactionContext) => Promise<T>) =>
          work({ transactionId: "tx" } as TransactionContext),
      },
      enabledFeatureGate(),
      auditLog(),
    );

    await expect(
      useCase.execute({
        actor: actor(),
        expectedPolicyVersion: 0,
        policyRules: [],
        targetId: "target-1",
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_TARGET_POLICY_VERSION_INVALID",
    });
    expect(repositoryCalls).toBe(0);
  });

  it("rejects unsafe disable reason codes before writing or auditing", async () => {
    let transactionCalls = 0;
    let repositoryCalls = 0;
    let auditCalls = 0;
    const useCase = new DisableRepositoryTargetUseCase(
      {
        disableTarget: async () => {
          repositoryCalls += 1;
          throw new Error("not used");
        },
      } as unknown as IntegrationTargetRepository,
      {
        runInTransaction: async <T>(
          work: (context: TransactionContext) => Promise<T>,
        ) => {
          transactionCalls += 1;
          return work({ transactionId: "tx" } as TransactionContext);
        },
      },
      enabledFeatureGate(),
      {
        record: async () => {
          auditCalls += 1;
        },
      },
    );

    await expect(
      useCase.execute({
        actor: actor(),
        reason: "contains raw user text",
        targetId: "target-1",
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_TARGET_DISABLE_REASON_INVALID",
    });
    expect(transactionCalls).toBe(0);
    expect(repositoryCalls).toBe(0);
    expect(auditCalls).toBe(0);
  });

  it("records a safe audit event when target enable needs repository revalidation", async () => {
    const events: Array<Parameters<IntegrationTargetsAuditLog["record"]>[0]> = [];
    const useCase = new EnableRepositoryTargetUseCase(
      {
        enableRepositoryTarget: async () => {
          throw createSafeError({
            category: "validation",
            code: "CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED",
            message: "Repository availability must be revalidated.",
          });
        },
      } as unknown as IntegrationTargetRepository,
      {
        runInTransaction: async <T>(work: (context: TransactionContext) => Promise<T>) =>
          work({ transactionId: "tx" } as TransactionContext),
      },
      enabledFeatureGate(),
      settings(),
      {
        record: async (event) => {
          events.push(event);
        },
      },
    );

    await expect(
      useCase.execute({
        actor: actor(),
        githubRepositoryId: "repo-1",
        integrationConnectionId: "connection-1",
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED",
    });
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "integration_target.repository_revalidation_required",
        safeMetadata: {
          githubRepositoryId: "repo-1",
          reasonCode: "CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED",
        },
        subjectId: "connection-1",
        subjectKind: "integration_connection",
      }),
    ]);
  });

  it("records target enable audit inside the target transaction", async () => {
    const context = { transactionId: "tx-1" } as TransactionContext;
    const auditContexts: Array<TransactionContext | undefined> = [];
    const useCase = new EnableRepositoryTargetUseCase(
      {
        enableRepositoryTarget: async (
          _input: Parameters<IntegrationTargetRepository["enableRepositoryTarget"]>[0],
          receivedContext: TransactionContext,
        ) => {
          expect(receivedContext).toBe(context);
          return repositoryTargetView();
        },
      } as unknown as IntegrationTargetRepository,
      {
        runInTransaction: async <T>(work: (context: TransactionContext) => Promise<T>) =>
          work(context),
      },
      enabledFeatureGate(),
      settings(),
      {
        record: async (_event, receivedContext) => {
          auditContexts.push(receivedContext);
        },
      },
    );

    await useCase.execute({
      actor: actor(),
      githubRepositoryId: "repo-1",
      integrationConnectionId: "connection-1",
    });

    expect(auditContexts).toEqual([context]);
  });

  it("normalizes list pagination before calling repository ports", async () => {
    const repositoryInputs: unknown[] = [];
    const useCase = new ListRepositoryTargetsUseCase(
      {
        listTargets: async (
          input: Parameters<IntegrationTargetRepository["listTargets"]>[0],
        ) => {
          repositoryInputs.push(input);
          return [];
        },
      } as unknown as IntegrationTargetRepository,
      enabledFeatureGate(),
    );

    await useCase.execute({
      actor: actor(),
      pagination: { offset: 25 },
      status: "enabled",
    });

    expect(repositoryInputs).toEqual([
      expect.objectContaining({
        pagination: { limit: 100, offset: 25 },
        status: "enabled",
      }),
    ]);
  });

  it("rejects invalid list pagination before calling repository ports", async () => {
    let repositoryCalls = 0;
    const useCase = new ListRepositoryTargetsUseCase(
      {
        listTargets: async () => {
          repositoryCalls += 1;
          return [];
        },
      } as unknown as IntegrationTargetRepository,
      enabledFeatureGate(),
    );

    await expect(
      useCase.execute({
        actor: actor(),
        pagination: { limit: 101 },
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_REPOSITORY_TARGET_PAGINATION_INVALID",
    });
    expect(repositoryCalls).toBe(0);
  });

  it("requires a workspace id for non-desktop policy evaluation with a safe error", async () => {
    let repositoryCalls = 0;
    const useCase = new EvaluateTargetPolicyUseCase(
      {
        evaluatePolicy: async () => {
          repositoryCalls += 1;
          throw new Error("not used");
        },
      } as unknown as IntegrationTargetRepository,
      enabledFeatureGate(),
      settings(),
    );

    await expect(
      useCase.execute({
        capability: "github.issue_comment.request",
        subjectId: "workspace:workspace-1",
        subjectKind: "workspace",
        targetId: "target-1",
      }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_WORKSPACE_ID_REQUIRED",
    });
    expect(repositoryCalls).toBe(0);
  });
});

function actor(): DesktopClientActor {
  const workspace = parseWorkspaceId("workspace-1");
  const desktopClient = parseDesktopClientId("desktop-1");
  if (!workspace.ok) {
    throw workspace.error;
  }
  if (!desktopClient.ok) {
    throw desktopClient.error;
  }
  return {
    credentialId: "credential-1",
    desktopClientId: desktopClient.value,
    workspaceId: workspace.value,
  };
}

function repositoryTargetView(): RepositoryTargetView {
  return {
    binding: {
      archived: false,
      displayFullName: "octo/repo",
      displayName: "repo",
      displayOwner: "octo",
      githubInstallationId: "installation-1",
      githubRepositoryId: "repo-1",
      id: parseRepositoryTargetBindingId("binding-1"),
      integrationTargetId: parseIntegrationTargetId("target-1"),
      lastVerifiedAtMs: toUnixMilliseconds(0),
      private: false,
      repositoryAvailabilitySnapshotId: "availability-1",
    },
    policyRules: [],
    target: {
      createdAtMs: toUnixMilliseconds(0),
      displayName: "octo/repo",
      id: parseIntegrationTargetId("target-1"),
      integrationConnectionId: connectionId("connection-1"),
      policyVersion: 1,
      provider: "github",
      providerTargetId: "repo-1",
      status: "enabled",
      targetKind: "github_repository",
      updatedAtMs: toUnixMilliseconds(0),
      workspaceId: workspaceId("workspace-1"),
    },
  };
}

function workspaceId(value: string) {
  const result = parseWorkspaceId(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function connectionId(value: string) {
  const result = parseIntegrationConnectionId(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function enabledFeatureGate(): IntegrationTargetsFeatureGatePolicy {
  return {
    assertEnabled: async () => undefined,
  };
}

function disabledFeatureGate(): IntegrationTargetsFeatureGatePolicy {
  return {
    assertEnabled: async () => {
      throw integrationTargetsFeatureDisabledError("integration-targets");
    },
  };
}

function settings(): IntegrationTargetsSettings {
  return {
    repositoryAvailabilityMaxAgeMs: () => 86_400_000,
  };
}

function auditLog(): IntegrationTargetsAuditLog {
  return {
    record: async () => undefined,
  };
}
