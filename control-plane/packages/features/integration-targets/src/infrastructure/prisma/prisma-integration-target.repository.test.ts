import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PrismaTransactionRunner,
  type PrismaDatabaseClient,
} from "@agent-teams-control-plane/platform-database";
import {
  parseDesktopClientId,
  parseIntegrationConnectionId,
  parseWorkspaceId,
  toUnixMilliseconds,
} from "@agent-teams-control-plane/shared";

import { parseIntegrationTargetId } from "../../domain/index.js";
import { PrismaIntegrationTargetRepository } from "./prisma-integration-target.repository.js";

describe("PrismaIntegrationTargetRepository", () => {
  it("keeps the active target partial unique index in SQL migration", () => {
    const migrationSql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20260527000000_phase_6_integration_targets/migration.sql",
      ),
      "utf8",
    );

    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "integration_targets_active_target_key"',
    );
    expect(migrationSql).toContain("WHERE \"status\" <> 'deleted'");
    expect(migrationSql).toContain('"integration_targets_status_check"');
    expect(migrationSql).toContain('"target_policy_rules_subject_id_shape_check"');
  });

  it("fails closed when repository sync is incomplete and does not create targets", async () => {
    const operations: string[] = [];
    const client = {
      $queryRaw: async () => {
        operations.push("lock");
        return [];
      },
      integrationConnection: {
        findFirst: async () => {
          operations.push("connection:findFirst");
          return {
            provider: "github",
            providerInstallationId: "installation-1",
            repositoryAvailability: [
              {
                archived: false,
                available: true,
                displayFullName: "octo/repo",
                displayName: "repo",
                displayOwner: "octo",
                id: "availability-1",
                lastVerifiedAt: new Date(0),
                private: false,
                providerRepositoryId: "repo-1",
              },
            ],
            repositorySyncCursors: [
              {
                cursorKind: "github_installation_repositories",
                cursorValue: "next-page",
                status: "running",
              },
            ],
            status: "active",
          };
        },
      },
      integrationTarget: {
        createMany: async () => {
          operations.push("target:createMany");
        },
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    await expect(
      runner.runInTransaction((context) =>
        repository.enableRepositoryTarget(
          {
            desktopClientId: desktopClientId("desktop-1"),
            githubRepositoryId: "repo-1",
            initialPolicyRules: [],
            initialPolicyRulesProvided: false,
            integrationConnectionId: connectionId("connection-1"),
            nowMs: toUnixMilliseconds(1000),
            repositoryAvailabilityMaxAgeMs: 60_000,
            workspaceId: workspaceId("workspace-1"),
          },
          context,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED",
    });
    expect(operations).toEqual(["lock", "connection:findFirst"]);
  });

  it("maps missing repository availability snapshots to revalidation-required", async () => {
    const client = {
      $queryRaw: async () => [],
      integrationConnection: {
        findFirst: async () => ({
          provider: "github",
          providerInstallationId: "installation-1",
          repositoryAvailability: [],
          repositorySyncCursors: [
            {
              cursorKind: "github_installation_repositories",
              cursorValue: null,
              status: "completed",
            },
          ],
          status: "active",
        }),
      },
      integrationTarget: {
        createMany: async () => {
          throw new Error("not used");
        },
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    await expect(
      runner.runInTransaction((context) =>
        repository.enableRepositoryTarget(
          {
            desktopClientId: desktopClientId("desktop-1"),
            githubRepositoryId: "repo-1",
            initialPolicyRules: [],
            initialPolicyRulesProvided: false,
            integrationConnectionId: connectionId("connection-1"),
            nowMs: toUnixMilliseconds(1000),
            repositoryAvailabilityMaxAgeMs: 60_000,
            workspaceId: workspaceId("workspace-1"),
          },
          context,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED",
    });
  });

  it("rejects archived repositories before creating targets", async () => {
    const operations: string[] = [];
    const client = {
      $queryRaw: async () => {
        operations.push("lock");
        return [];
      },
      integrationConnection: {
        findFirst: async () => {
          operations.push("connection:findFirst");
          return {
            provider: "github",
            providerInstallationId: "installation-1",
            repositoryAvailability: [
              {
                archived: true,
                available: true,
                displayFullName: "octo/repo",
                displayName: "repo",
                displayOwner: "octo",
                id: "availability-1",
                lastVerifiedAt: new Date(1000),
                private: false,
                providerRepositoryId: "repo-1",
              },
            ],
            repositorySyncCursors: [
              {
                cursorKind: "github_installation_repositories",
                cursorValue: null,
                status: "completed",
              },
            ],
            status: "active",
          };
        },
      },
      integrationTarget: {
        createMany: async () => {
          operations.push("target:createMany");
          throw new Error("not used");
        },
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    await expect(
      runner.runInTransaction((context) =>
        repository.enableRepositoryTarget(
          {
            desktopClientId: desktopClientId("desktop-1"),
            githubRepositoryId: "repo-1",
            initialPolicyRules: [],
            initialPolicyRulesProvided: false,
            integrationConnectionId: connectionId("connection-1"),
            nowMs: toUnixMilliseconds(1000),
            repositoryAvailabilityMaxAgeMs: 60_000,
            workspaceId: workspaceId("workspace-1"),
          },
          context,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_REPOSITORY_ARCHIVED",
    });
    expect(operations).toEqual(["lock", "connection:findFirst"]);
  });

  it("rejects duplicate enable when explicit initial policy differs from existing policy", async () => {
    const existing = targetRow({
      policyVersion: 1,
      targetPolicyRules: [
        {
          capability: "github.issue_comment.request",
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        },
      ],
    });
    const client = {
      $queryRaw: async () => [],
      integrationConnection: {
        findFirst: async () => ({
          provider: "github",
          providerInstallationId: "installation-1",
          repositoryAvailability: [
            {
              archived: false,
              available: true,
              displayFullName: "octo/repo",
              displayName: "repo",
              displayOwner: "octo",
              id: "availability-1",
              lastVerifiedAt: new Date(1000),
              private: false,
              providerRepositoryId: "repo-1",
            },
          ],
          repositorySyncCursors: [
            {
              cursorKind: "github_installation_repositories",
              cursorValue: null,
              status: "completed",
            },
          ],
          status: "active",
        }),
      },
      integrationTarget: {
        findFirst: async () => existing,
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    await expect(
      runner.runInTransaction((context) =>
        repository.enableRepositoryTarget(
          {
            desktopClientId: desktopClientId("desktop-1"),
            githubRepositoryId: "repo-1",
            initialPolicyRules: [],
            initialPolicyRulesProvided: true,
            integrationConnectionId: connectionId("connection-1"),
            nowMs: toUnixMilliseconds(1000),
            repositoryAvailabilityMaxAgeMs: 60_000,
            workspaceId: workspaceId("workspace-1"),
          },
          context,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_TARGET_ALREADY_ENABLED_WITH_DIFFERENT_POLICY",
    });
  });

  it("treats duplicate policy replacement as idempotent when expected version matches", async () => {
    const operations: string[] = [];
    const row = targetRow({
      policyVersion: 2,
      targetPolicyRules: [
        {
          capability: "github.issue_comment.request",
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        },
      ],
    });
    const client = {
      integrationTarget: {
        findFirst: async () => {
          operations.push("target:findFirst");
          return row;
        },
        update: async () => {
          operations.push("target:update");
          throw new Error("not used");
        },
      },
      targetPolicyRule: {
        deleteMany: async () => {
          operations.push("policy:deleteMany");
          throw new Error("not used");
        },
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    const result = await runner.runInTransaction((context) =>
      repository.replacePolicy(
        {
          desktopClientId: desktopClientId("desktop-1"),
          expectedPolicyVersion: 2,
          nowMs: toUnixMilliseconds(1000),
          policyRules: [
            {
              capability: "github.issue_comment.request",
              effect: "allow",
              subjectId: " workspace:workspace-1 ",
              subjectKind: "workspace",
            },
          ],
          targetId: parseIntegrationTargetId("target-1"),
          workspaceId: workspaceId("workspace-1"),
        },
        context,
      ),
    );

    expect(result.target.policyVersion).toBe(2);
    expect(operations).toEqual(["target:findFirst"]);
  });

  it("rejects stale policy versions even when requested policy is identical", async () => {
    const row = targetRow({
      policyVersion: 2,
      targetPolicyRules: [
        {
          capability: "github.issue_comment.request",
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        },
      ],
    });
    const client = {
      integrationTarget: {
        findFirst: async () => row,
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    await expect(
      runner.runInTransaction((context) =>
        repository.replacePolicy(
          {
            desktopClientId: desktopClientId("desktop-1"),
            expectedPolicyVersion: 1,
            nowMs: toUnixMilliseconds(1000),
            policyRules: [
              {
                capability: "github.issue_comment.request",
                effect: "allow",
                subjectId: " workspace:workspace-1 ",
                subjectKind: "workspace",
              },
            ],
            targetId: parseIntegrationTargetId("target-1"),
            workspaceId: workspaceId("workspace-1"),
          },
          context,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_TARGET_POLICY_VERSION_CONFLICT",
    });
  });

  it("rejects stale policy versions when requested policy differs", async () => {
    const operations: string[] = [];
    const row = targetRow({
      policyVersion: 2,
      targetPolicyRules: [
        {
          capability: "github.issue_comment.request",
          effect: "allow",
          subjectId: "workspace:workspace-1",
          subjectKind: "workspace",
        },
      ],
    });
    const client = {
      integrationTarget: {
        findFirst: async () => {
          operations.push("target:findFirst");
          return row;
        },
        update: async () => {
          operations.push("target:update");
          throw new Error("not used");
        },
      },
      targetPolicyRule: {
        deleteMany: async () => {
          operations.push("policy:deleteMany");
          throw new Error("not used");
        },
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    await expect(
      runner.runInTransaction((context) =>
        repository.replacePolicy(
          {
            desktopClientId: desktopClientId("desktop-1"),
            expectedPolicyVersion: 1,
            nowMs: toUnixMilliseconds(1000),
            policyRules: [
              {
                capability: "github.pr_review.request",
                effect: "allow",
                subjectId: "workspace:workspace-1",
                subjectKind: "workspace",
              },
            ],
            targetId: parseIntegrationTargetId("target-1"),
            workspaceId: workspaceId("workspace-1"),
          },
          context,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_TARGET_POLICY_VERSION_CONFLICT",
    });
    expect(operations).toEqual(["target:findFirst"]);
  });

  it("denies policy replacement when the integration connection is suspended", async () => {
    const client = {
      integrationTarget: {
        findFirst: async () => ({
          ...targetRow({
            policyVersion: 1,
            targetPolicyRules: [],
          }),
          integrationConnection: {
            status: "suspended",
          },
        }),
      },
    };
    const repository = new PrismaIntegrationTargetRepository(fakeDatabase(client));
    const runner = new PrismaTransactionRunner(fakeDatabaseWithTransaction(client));

    await expect(
      runner.runInTransaction((context) =>
        repository.replacePolicy(
          {
            desktopClientId: desktopClientId("desktop-1"),
            expectedPolicyVersion: 1,
            nowMs: toUnixMilliseconds(1000),
            policyRules: [],
            targetId: parseIntegrationTargetId("target-1"),
            workspaceId: workspaceId("workspace-1"),
          },
          context,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_INTEGRATION_CONNECTION_SUSPENDED",
    });
  });

  it("denies policy evaluation when the integration connection is suspended", async () => {
    const repository = new PrismaIntegrationTargetRepository(
      fakeDatabase({
        integrationTarget: {
          findFirst: async () => ({
            ...targetRow({
              policyVersion: 1,
              targetPolicyRules: [
                {
                  capability: "github.issue_comment.request",
                  effect: "allow",
                  subjectId: "workspace:workspace-1",
                  subjectKind: "workspace",
                },
              ],
            }),
            integrationConnection: {
              status: "suspended",
            },
          }),
        },
      }),
    );

    await expect(
      repository.evaluatePolicy({
        capability: "github.issue_comment.request",
        nowMs: toUnixMilliseconds(1000),
        repositoryAvailabilityMaxAgeMs: 60_000,
        subjectId: "workspace:workspace-1",
        subjectKind: "workspace",
        targetId: parseIntegrationTargetId("target-1"),
        workspaceId: workspaceId("workspace-1"),
      }),
    ).resolves.toEqual({
      allowed: false,
      policyVersion: 1,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_CONNECTION_SUSPENDED",
    });
  });

  it("denies policy evaluation when repository sync is incomplete", async () => {
    const repository = new PrismaIntegrationTargetRepository(
      fakeDatabase({
        integrationTarget: {
          findFirst: async () => ({
            ...targetRow({
              policyVersion: 1,
              targetPolicyRules: [
                {
                  capability: "github.issue_comment.request",
                  effect: "allow",
                  subjectId: "workspace:workspace-1",
                  subjectKind: "workspace",
                },
              ],
            }),
            integrationConnection: {
              repositorySyncCursors: [
                {
                  cursorKind: "github_installation_repositories",
                  cursorValue: "next-page",
                  status: "running",
                },
              ],
              status: "active",
            },
          }),
        },
      }),
    );

    await expect(
      repository.evaluatePolicy({
        capability: "github.issue_comment.request",
        nowMs: toUnixMilliseconds(1000),
        repositoryAvailabilityMaxAgeMs: 60_000,
        subjectId: "workspace:workspace-1",
        subjectKind: "workspace",
        targetId: parseIntegrationTargetId("target-1"),
        workspaceId: workspaceId("workspace-1"),
      }),
    ).resolves.toEqual({
      allowed: false,
      policyVersion: 1,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_TARGET_STALE",
    });
  });

  it("denies policy evaluation when the bound repository snapshot is expired", async () => {
    const repository = new PrismaIntegrationTargetRepository(
      fakeDatabase({
        integrationTarget: {
          findFirst: async () =>
            targetRow({
              policyVersion: 1,
              targetPolicyRules: [
                {
                  capability: "github.issue_comment.request",
                  effect: "allow",
                  subjectId: "workspace:workspace-1",
                  subjectKind: "workspace",
                },
              ],
            }),
        },
      }),
    );

    await expect(
      repository.evaluatePolicy({
        capability: "github.issue_comment.request",
        nowMs: toUnixMilliseconds(1000),
        repositoryAvailabilityMaxAgeMs: 10,
        subjectId: "workspace:workspace-1",
        subjectKind: "workspace",
        targetId: parseIntegrationTargetId("target-1"),
        workspaceId: workspaceId("workspace-1"),
      }),
    ).resolves.toEqual({
      allowed: false,
      policyVersion: 1,
      reasonCode: "CONTROL_PLANE_TARGET_POLICY_TARGET_STALE",
    });
  });
});

function fakeDatabase(client: unknown): PrismaDatabaseClient {
  return {
    getClient: () => client,
  } as unknown as PrismaDatabaseClient;
}

function fakeDatabaseWithTransaction(client: unknown): PrismaDatabaseClient {
  return fakeDatabase({
    $transaction: async <T>(work: (transactionClient: unknown) => Promise<T>) =>
      work(client),
  });
}

function targetRow(input: {
  policyVersion: number;
  targetPolicyRules: Array<{
    subjectKind: string;
    subjectId: string;
    capability: string;
    effect: string;
  }>;
}) {
  return {
    createdAt: new Date(0),
    deletedAt: null,
    disabledAt: null,
    displayName: "octo/repo",
    githubRepositoryBinding: {
      archived: false,
      displayFullName: "octo/repo",
      displayName: "repo",
      displayOwner: "octo",
      githubInstallationId: "installation-1",
      githubNodeId: null,
      githubRepositoryId: "repo-1",
      id: "binding-1",
      integrationTargetId: "target-1",
      lastVerifiedAt: new Date(0),
      private: false,
      repositoryAvailabilitySnapshotId: "availability-1",
    },
    id: "target-1",
    integrationConnection: {
      status: "active",
    },
    integrationConnectionId: "connection-1",
    policyVersion: input.policyVersion,
    provider: "github",
    providerTargetId: "repo-1",
    staleAt: null,
    status: "enabled",
    targetKind: "github_repository",
    targetPolicyRules: input.targetPolicyRules.map((rule, index) => ({
      ...rule,
      createdAt: new Date(0),
      createdByDesktopClientId: "desktop-1",
      id: `rule-${index + 1}`,
      integrationTargetId: "target-1",
      workspaceId: "workspace-1",
    })),
    updatedAt: new Date(0),
    workspaceId: "workspace-1",
  };
}

function workspaceId(value: string) {
  const result = parseWorkspaceId(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function desktopClientId(value: string) {
  const result = parseDesktopClientId(value);
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
