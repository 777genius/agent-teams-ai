import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  getPrismaTransactionClient,
  PRISMA_DATABASE_CLIENT,
  type PrismaClientLike,
  type PrismaDatabaseClient,
  type PrismaTransactionClientLike,
} from "@agent-teams-control-plane/platform-database";
import {
  createSafeError,
  parseDesktopClientId,
  parseIntegrationConnectionId,
  parseWorkspaceId,
  toUnixMilliseconds,
  type SafeError,
} from "@agent-teams-control-plane/shared";

import {
  canonicalTargetPolicyFingerprint,
  evaluateTargetPolicy,
  parseIntegrationTargetId,
  parseRepositoryTargetBindingId,
  parseTargetPolicyRuleId,
  type IntegrationTarget,
  type IntegrationTargetStatus,
  type RepositoryTargetBinding,
  type TargetPolicyRule,
  type TargetPolicyRuleInput,
} from "../../domain/index.js";
import type {
  AvailableRepositoryTargetsView,
  EnableRepositoryTargetRepositoryInput,
  EvaluateTargetPolicyRepositoryInput,
  IntegrationTargetRepository,
  RepositoryAvailabilityView,
  RepositoryTargetView,
  ReplaceTargetPolicyRepositoryInput,
  TargetPolicyEvaluationView,
} from "../../application/ports/integration-target.repository.js";
import type { TransactionContext } from "../../application/ports/transaction-runner.js";

type PrismaWriteClient = PrismaClientLike | PrismaTransactionClientLike;
type TargetRow = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<PrismaDatabaseClient["getClient"]>["integrationTarget"]["findFirst"]
    >
  >
>;
type TargetWithRelationsRow = TargetRow & {
  integrationConnection?: {
    repositorySyncCursors?: Array<{
      cursorKind: string;
      cursorValue: string | null;
      status: string;
    }>;
    status: string;
  };
  githubRepositoryBinding: {
    id: string;
    integrationTargetId: string;
    githubInstallationId: string;
    githubRepositoryId: string;
    githubNodeId: string | null;
    displayOwner: string;
    displayName: string;
    displayFullName: string;
    private: boolean;
    archived: boolean;
    lastVerifiedAt: Date;
    repositoryAvailabilitySnapshotId: string | null;
  } | null;
  targetPolicyRules: Array<{
    id: string;
    workspaceId: string;
    integrationTargetId: string;
    subjectKind: string;
    subjectId: string;
    capability: string;
    effect: string;
    createdAt: Date;
    createdByDesktopClientId: string;
  }>;
};

@Injectable()
export class PrismaIntegrationTargetRepository implements IntegrationTargetRepository {
  public constructor(
    @Inject(PRISMA_DATABASE_CLIENT)
    private readonly databaseClient: PrismaDatabaseClient,
  ) {}

  public async listAvailableRepositories(input: {
    workspaceId: Parameters<
      IntegrationTargetRepository["listAvailableRepositories"]
    >[0]["workspaceId"];
    integrationConnectionId: Parameters<
      IntegrationTargetRepository["listAvailableRepositories"]
    >[0]["integrationConnectionId"];
    filters?: Parameters<
      IntegrationTargetRepository["listAvailableRepositories"]
    >[0]["filters"];
    pagination?: Parameters<
      IntegrationTargetRepository["listAvailableRepositories"]
    >[0]["pagination"];
  }): Promise<AvailableRepositoryTargetsView> {
    const connection = await this.databaseClient
      .getClient()
      .integrationConnection.findFirst({
        include: {
          integrationTargets: {
            include: {
              githubRepositoryBinding: true,
              targetPolicyRules: true,
            },
            where: {
              status: { not: "deleted" },
              targetKind: "github_repository",
            },
          },
          repositoryAvailability: {
            orderBy: { displayFullName: "asc" },
          },
          repositorySyncCursors: true,
        },
        where: {
          id: input.integrationConnectionId,
          workspaceId: input.workspaceId,
        },
      });

    if (connection === null || connection.status === "deleted") {
      throw createSafeError({
        category: "not-found",
        code: "CONTROL_PLANE_INTEGRATION_CONNECTION_NOT_FOUND",
        message: "Integration connection was not found.",
      });
    }
    if (connection.status !== "active") {
      throw createSafeError({
        category: "authorization",
        code: "CONTROL_PLANE_INTEGRATION_CONNECTION_SUSPENDED",
        message: "Integration connection is suspended.",
      });
    }
    if (connection.provider !== "github") {
      throw createSafeError({
        category: "validation",
        code: "CONTROL_PLANE_INTEGRATION_PROVIDER_UNSUPPORTED",
        message: "Integration provider is not supported for repository targets.",
      });
    }

    const targetsByRepositoryId = new Map(
      connection.integrationTargets.flatMap((target) => {
        const row = target as TargetWithRelationsRow;
        const binding = row.githubRepositoryBinding;
        return binding === null ? [] : [[binding.githubRepositoryId, mapTarget(row)]];
      }),
    );

    const repositories = connection.repositoryAvailability
      .map((repository): RepositoryAvailabilityView => {
        const target = targetsByRepositoryId.get(repository.providerRepositoryId);
        return {
          archived: repository.archived,
          availabilitySnapshotId: repository.id,
          available: repository.available,
          displayFullName: repository.displayFullName,
          displayName: repository.displayName,
          displayOwner: repository.displayOwner,
          lastVerifiedAtMs: toUnixMilliseconds(repository.lastVerifiedAt.getTime()),
          private: repository.private,
          providerRepositoryId: repository.providerRepositoryId,
          ...(target === undefined ? {} : { target }),
        };
      })
      .filter((repository) => matchesAvailabilityFilters(repository, input.filters));

    return {
      connection: {
        id: parseIntegrationConnectionIdOrThrow(connection.id),
        provider: "github",
        providerInstallationId: connection.providerInstallationId,
        repositorySyncStatus: mapRepositorySyncStatus(connection.repositorySyncCursors),
        status: assertConnectionStatus(connection.status),
        workspaceId: parseWorkspaceIdOrThrow(connection.workspaceId),
      },
      repositories: applyPagination(repositories, input.pagination),
    };
  }

  public async listTargets(input: {
    workspaceId: Parameters<IntegrationTargetRepository["listTargets"]>[0]["workspaceId"];
    status?: string;
    pagination?: Parameters<IntegrationTargetRepository["listTargets"]>[0]["pagination"];
  }): Promise<readonly RepositoryTargetView[]> {
    const rows = await this.databaseClient.getClient().integrationTarget.findMany({
      include: {
        githubRepositoryBinding: true,
        targetPolicyRules: { orderBy: [{ subjectKind: "asc" }, { subjectId: "asc" }] },
      },
      orderBy: { createdAt: "desc" },
      ...(input.pagination === undefined
        ? {}
        : { skip: input.pagination.offset, take: input.pagination.limit }),
      where: {
        ...(input.status === undefined
          ? { status: { not: "deleted" } }
          : { status: input.status }),
        targetKind: "github_repository",
        workspaceId: input.workspaceId,
      },
    });
    return rows.map((row) => mapTargetView(row as TargetWithRelationsRow));
  }

  public async findTarget(input: {
    workspaceId: Parameters<IntegrationTargetRepository["findTarget"]>[0]["workspaceId"];
    targetId: Parameters<IntegrationTargetRepository["findTarget"]>[0]["targetId"];
  }): Promise<RepositoryTargetView | undefined> {
    const row = await this.databaseClient.getClient().integrationTarget.findFirst({
      include: {
        githubRepositoryBinding: true,
        targetPolicyRules: { orderBy: [{ subjectKind: "asc" }, { subjectId: "asc" }] },
      },
      where: {
        id: input.targetId,
        status: { not: "deleted" },
        workspaceId: input.workspaceId,
      },
    });
    return row === null ? undefined : mapTargetView(row as TargetWithRelationsRow);
  }

  public async enableRepositoryTarget(
    input: EnableRepositoryTargetRepositoryInput,
    context: TransactionContext,
  ): Promise<RepositoryTargetView> {
    const client = getPrismaTransactionClient(context);
    await client.$queryRaw<readonly { locked: unknown }[]>`
      SELECT pg_advisory_xact_lock(hashtext('integration-target'), hashtext(${`${input.workspaceId}:${input.integrationConnectionId}:${input.githubRepositoryId}`})) AS locked
    `;

    const source = await loadConnectionRepositorySource(client, input);
    validateRepositoryCanBecomeTarget(input, source);

    const existing = await findExistingTargetForRepository(client, input);
    if (existing !== null) {
      return enableExistingTarget(client, input, existing as TargetWithRelationsRow);
    }

    const targetId = randomUUID();
    await client.integrationTarget.createMany({
      data: {
        createdAt: new Date(input.nowMs),
        displayName: source.repository.displayFullName,
        id: targetId,
        integrationConnectionId: input.integrationConnectionId,
        provider: "github",
        providerTargetId: source.repository.providerRepositoryId,
        status: "enabled",
        targetKind: "github_repository",
        updatedAt: new Date(input.nowMs),
        workspaceId: input.workspaceId,
      },
      skipDuplicates: true,
    });

    const target = await findExistingTargetForRepository(client, input);
    if (target === null || target.status === "deleted") {
      throw createSafeError({
        category: "internal",
        code: "CONTROL_PLANE_TARGET_ENABLE_FAILED",
        message: "Repository target could not be enabled.",
      });
    }

    await client.gitHubRepositoryTargetBinding.createMany({
      data: {
        archived: source.repository.archived,
        displayFullName: source.repository.displayFullName,
        displayName: source.repository.displayName,
        displayOwner: source.repository.displayOwner,
        githubInstallationId: source.connection.providerInstallationId,
        githubRepositoryId: source.repository.providerRepositoryId,
        id: randomUUID(),
        integrationTargetId: target.id,
        lastVerifiedAt: source.repository.lastVerifiedAt,
        private: source.repository.private,
        repositoryAvailabilitySnapshotId: source.repository.id,
      },
      skipDuplicates: true,
    });

    await insertPolicyRules(client, {
      desktopClientId: input.desktopClientId,
      nowMs: input.nowMs,
      policyRules: input.initialPolicyRules,
      targetId: parseIntegrationTargetId(target.id),
      workspaceId: input.workspaceId,
    });

    return mustLoadTargetView(client, input.workspaceId, target.id);
  }

  public async disableTarget(
    input: Parameters<IntegrationTargetRepository["disableTarget"]>[0],
    context: TransactionContext,
  ): Promise<RepositoryTargetView> {
    const client = getPrismaTransactionClient(context);
    const target = await client.integrationTarget.findFirst({
      where: {
        id: input.targetId,
        status: { not: "deleted" },
        workspaceId: input.workspaceId,
      },
    });
    if (target === null) {
      throw targetNotFoundError();
    }
    if (target.status === "revoked") {
      throw createSafeError({
        category: "authorization",
        code: "CONTROL_PLANE_TARGET_REVOKED",
        message: "Repository target is revoked.",
      });
    }
    if (target.status !== "disabled") {
      await client.integrationTarget.update({
        data: {
          disabledAt: new Date(input.nowMs),
          status: "disabled",
          updatedAt: new Date(input.nowMs),
        },
        where: { id: target.id },
      });
    }
    return mustLoadTargetView(client, input.workspaceId, target.id);
  }

  public async replacePolicy(
    input: ReplaceTargetPolicyRepositoryInput,
    context: TransactionContext,
  ): Promise<RepositoryTargetView> {
    const client = getPrismaTransactionClient(context);
    const current = await loadTargetForPolicyUpdate(client, input);
    const currentFingerprint = canonicalTargetPolicyFingerprint(
      current.targetPolicyRules.map(mapPolicyRuleInput),
    );
    const requestedFingerprint = canonicalTargetPolicyFingerprint(input.policyRules);

    if (current.policyVersion !== input.expectedPolicyVersion) {
      throw createSafeError({
        category: "conflict",
        code: "CONTROL_PLANE_TARGET_POLICY_VERSION_CONFLICT",
        message: "Target policy version is stale.",
        safeDetails: { currentPolicyVersion: current.policyVersion },
      });
    }

    if (currentFingerprint === requestedFingerprint) {
      return mapTargetView(current);
    }

    await client.targetPolicyRule.deleteMany({
      where: {
        integrationTargetId: input.targetId,
        workspaceId: input.workspaceId,
      },
    });
    await insertPolicyRules(client, {
      desktopClientId: input.desktopClientId,
      nowMs: input.nowMs,
      policyRules: input.policyRules,
      targetId: input.targetId,
      workspaceId: input.workspaceId,
    });
    await client.integrationTarget.update({
      data: {
        policyVersion: { increment: 1 },
        updatedAt: new Date(input.nowMs),
      },
      where: { id: input.targetId },
    });

    return mustLoadTargetView(client, input.workspaceId, input.targetId);
  }

  public async evaluatePolicy(
    input: EvaluateTargetPolicyRepositoryInput,
  ): Promise<TargetPolicyEvaluationView> {
    const row = await loadTargetForPolicyEvaluation(
      this.databaseClient.getClient(),
      input,
    );
    if (row.integrationConnection?.status !== "active") {
      return {
        allowed: false,
        policyVersion: row.policyVersion,
        reasonCode: "CONTROL_PLANE_TARGET_POLICY_CONNECTION_SUSPENDED",
      };
    }
    if (
      row.integrationConnection.repositorySyncCursors !== undefined &&
      !mapRepositorySyncStatus(row.integrationConnection.repositorySyncCursors).complete
    ) {
      return {
        allowed: false,
        policyVersion: row.policyVersion,
        reasonCode: "CONTROL_PLANE_TARGET_POLICY_TARGET_STALE",
      };
    }
    const targetView = mapTargetView(row);
    if (
      input.nowMs - targetView.binding.lastVerifiedAtMs >
      input.repositoryAvailabilityMaxAgeMs
    ) {
      return {
        allowed: false,
        policyVersion: targetView.target.policyVersion,
        reasonCode: "CONTROL_PLANE_TARGET_POLICY_TARGET_STALE",
      };
    }
    const workspaceSubjectId = `workspace:${input.workspaceId}`;
    const result = evaluateTargetPolicy({
      capability: input.capability,
      rules: targetView.policyRules,
      subjectId: input.subjectId,
      subjectKind: input.subjectKind,
      target: targetView.target,
      workspaceSubjectId,
      ...(input.agentSubjectId === undefined
        ? {}
        : { agentSubjectId: input.agentSubjectId }),
      ...(input.desktopClientSubjectId === undefined
        ? {}
        : { desktopClientSubjectId: input.desktopClientSubjectId }),
      ...(input.teamSubjectId === undefined
        ? {}
        : { teamSubjectId: input.teamSubjectId }),
    });
    return {
      allowed: result.allowed,
      policyVersion: result.policyVersion,
      reasonCode: result.reasonCode,
    };
  }
}

async function loadConnectionRepositorySource(
  client: PrismaTransactionClientLike,
  input: EnableRepositoryTargetRepositoryInput,
) {
  const connection = await client.integrationConnection.findFirst({
    include: {
      repositoryAvailability: {
        where: { providerRepositoryId: input.githubRepositoryId },
      },
      repositorySyncCursors: true,
    },
    where: {
      id: input.integrationConnectionId,
      workspaceId: input.workspaceId,
    },
  });
  if (connection === null || connection.status === "deleted") {
    throw createSafeError({
      category: "not-found",
      code: "CONTROL_PLANE_INTEGRATION_CONNECTION_NOT_FOUND",
      message: "Integration connection was not found.",
    });
  }
  if (connection.provider !== "github") {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_INTEGRATION_PROVIDER_UNSUPPORTED",
      message: "Integration provider is not supported for repository targets.",
    });
  }
  if (connection.status !== "active") {
    throw createSafeError({
      category: "authorization",
      code: "CONTROL_PLANE_INTEGRATION_CONNECTION_SUSPENDED",
      message: "Integration connection is suspended.",
    });
  }
  const repository = connection.repositoryAvailability[0];
  if (repository === undefined) {
    throw revalidationRequiredError();
  }
  return { connection, repository };
}

function validateRepositoryCanBecomeTarget(
  input: EnableRepositoryTargetRepositoryInput,
  source: Awaited<ReturnType<typeof loadConnectionRepositorySource>>,
): void {
  const sync = mapRepositorySyncStatus(source.connection.repositorySyncCursors);
  if (!sync.complete) {
    throw revalidationRequiredError();
  }
  if (!source.repository.available) {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_REPOSITORY_NOT_AVAILABLE",
      message: "Repository is not available for this integration.",
    });
  }
  if (source.repository.archived) {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_REPOSITORY_ARCHIVED",
      message: "Archived repositories cannot be enabled as write targets.",
    });
  }
  const verifiedAtMs = source.repository.lastVerifiedAt.getTime();
  if (input.nowMs - verifiedAtMs > input.repositoryAvailabilityMaxAgeMs) {
    throw revalidationRequiredError();
  }
}

async function findExistingTargetForRepository(
  client: PrismaTransactionClientLike,
  input: EnableRepositoryTargetRepositoryInput,
): Promise<TargetWithRelationsRow | null> {
  return (await client.integrationTarget.findFirst({
    include: {
      githubRepositoryBinding: true,
      targetPolicyRules: { orderBy: [{ subjectKind: "asc" }, { subjectId: "asc" }] },
    },
    where: {
      integrationConnectionId: input.integrationConnectionId,
      providerTargetId: input.githubRepositoryId,
      targetKind: "github_repository",
      workspaceId: input.workspaceId,
    },
  })) as TargetWithRelationsRow | null;
}

async function enableExistingTarget(
  client: PrismaTransactionClientLike,
  input: EnableRepositoryTargetRepositoryInput,
  existing: TargetWithRelationsRow,
): Promise<RepositoryTargetView> {
  if (existing.status === "deleted") {
    throw createSafeError({
      category: "conflict",
      code: "CONTROL_PLANE_TARGET_RECREATE_NOT_SUPPORTED",
      message: "Deleted repository targets cannot be recreated yet.",
    });
  }
  if (existing.status === "revoked") {
    throw createSafeError({
      category: "authorization",
      code: "CONTROL_PLANE_TARGET_REVOKED",
      message: "Repository target is revoked.",
    });
  }
  assertInitialPolicyCompatible(existing, input);
  if (existing.status !== "enabled") {
    await client.integrationTarget.update({
      data: {
        disabledAt: null,
        staleAt: null,
        status: "enabled",
        updatedAt: new Date(input.nowMs),
      },
      where: { id: existing.id },
    });
  }
  return mustLoadTargetView(client, input.workspaceId, existing.id);
}

function assertInitialPolicyCompatible(
  existing: TargetWithRelationsRow,
  input: EnableRepositoryTargetRepositoryInput,
): void {
  if (!input.initialPolicyRulesProvided) {
    return;
  }
  const existingFingerprint = canonicalTargetPolicyFingerprint(
    existing.targetPolicyRules.map(mapPolicyRuleInput),
  );
  const requestedFingerprint = canonicalTargetPolicyFingerprint(input.initialPolicyRules);
  if (existingFingerprint !== requestedFingerprint) {
    throw createSafeError({
      category: "conflict",
      code: "CONTROL_PLANE_TARGET_ALREADY_ENABLED_WITH_DIFFERENT_POLICY",
      message: "Repository target already exists with a different policy.",
    });
  }
}

async function insertPolicyRules(
  client: PrismaTransactionClientLike,
  input: {
    workspaceId: EnableRepositoryTargetRepositoryInput["workspaceId"];
    targetId: ReturnType<typeof parseIntegrationTargetId>;
    desktopClientId: EnableRepositoryTargetRepositoryInput["desktopClientId"];
    policyRules: readonly TargetPolicyRuleInput[];
    nowMs: EnableRepositoryTargetRepositoryInput["nowMs"];
  },
): Promise<void> {
  if (input.policyRules.length === 0) {
    return;
  }
  await client.targetPolicyRule.createMany({
    data: input.policyRules.map((rule) => ({
      capability: rule.capability,
      createdAt: new Date(input.nowMs),
      createdByDesktopClientId: input.desktopClientId,
      effect: rule.effect,
      id: randomUUID(),
      integrationTargetId: input.targetId,
      subjectId: rule.subjectId.trim(),
      subjectKind: rule.subjectKind,
      workspaceId: input.workspaceId,
    })),
  });
}

async function loadTargetForPolicyUpdate(
  client: PrismaTransactionClientLike,
  input: ReplaceTargetPolicyRepositoryInput,
): Promise<TargetWithRelationsRow> {
  const target = await client.integrationTarget.findFirst({
    include: {
      githubRepositoryBinding: true,
      integrationConnection: {
        select: {
          repositorySyncCursors: true,
          status: true,
        },
      },
      targetPolicyRules: { orderBy: [{ subjectKind: "asc" }, { subjectId: "asc" }] },
    },
    where: {
      id: input.targetId,
      status: { not: "deleted" },
      workspaceId: input.workspaceId,
    },
  });
  if (target === null) {
    throw targetNotFoundError();
  }
  const row = target as TargetWithRelationsRow;
  if (row.integrationConnection?.status !== "active") {
    throw createSafeError({
      category: "authorization",
      code: "CONTROL_PLANE_INTEGRATION_CONNECTION_SUSPENDED",
      message: "Integration connection is suspended.",
    });
  }
  return row;
}

async function loadTargetForPolicyEvaluation(
  client: PrismaClientLike,
  input: EvaluateTargetPolicyRepositoryInput,
): Promise<TargetWithRelationsRow> {
  const target = await client.integrationTarget.findFirst({
    include: {
      githubRepositoryBinding: true,
      integrationConnection: { select: { status: true } },
      targetPolicyRules: { orderBy: [{ subjectKind: "asc" }, { subjectId: "asc" }] },
    },
    where: {
      id: input.targetId,
      status: { not: "deleted" },
      workspaceId: input.workspaceId,
    },
  });
  if (target === null) {
    throw targetNotFoundError();
  }
  return target as TargetWithRelationsRow;
}

async function mustLoadTargetView(
  client: PrismaWriteClient,
  workspaceId: string,
  targetId: string,
): Promise<RepositoryTargetView> {
  const row = await client.integrationTarget.findFirst({
    include: {
      githubRepositoryBinding: true,
      targetPolicyRules: { orderBy: [{ subjectKind: "asc" }, { subjectId: "asc" }] },
    },
    where: {
      id: targetId,
      status: { not: "deleted" },
      workspaceId,
    },
  });
  if (row === null) {
    throw targetNotFoundError();
  }
  return mapTargetView(row as TargetWithRelationsRow);
}

function mapTargetView(row: TargetWithRelationsRow): RepositoryTargetView {
  if (row.githubRepositoryBinding === null) {
    throw createSafeError({
      category: "internal",
      code: "CONTROL_PLANE_TARGET_BINDING_MISSING",
      message: "Repository target binding is missing.",
    });
  }
  return {
    binding: mapBinding(row.githubRepositoryBinding),
    policyRules: row.targetPolicyRules.map(mapPolicyRule),
    target: mapTarget(row),
  };
}

function mapTarget(row: TargetRow): IntegrationTarget {
  return {
    createdAtMs: toUnixMilliseconds(row.createdAt.getTime()),
    displayName: row.displayName,
    id: parseIntegrationTargetId(row.id),
    integrationConnectionId: parseIntegrationConnectionIdOrThrow(
      row.integrationConnectionId,
    ),
    policyVersion: row.policyVersion,
    provider: "github",
    providerTargetId: row.providerTargetId,
    status: assertTargetStatus(row.status),
    targetKind: "github_repository",
    updatedAtMs: toUnixMilliseconds(row.updatedAt.getTime()),
    workspaceId: parseWorkspaceIdOrThrow(row.workspaceId),
    ...(row.deletedAt === null
      ? {}
      : { deletedAtMs: toUnixMilliseconds(row.deletedAt.getTime()) }),
    ...(row.disabledAt === null
      ? {}
      : { disabledAtMs: toUnixMilliseconds(row.disabledAt.getTime()) }),
    ...(row.staleAt === null
      ? {}
      : { staleAtMs: toUnixMilliseconds(row.staleAt.getTime()) }),
  };
}

function mapBinding(
  row: NonNullable<TargetWithRelationsRow["githubRepositoryBinding"]>,
): RepositoryTargetBinding {
  return {
    archived: row.archived,
    displayFullName: row.displayFullName,
    displayName: row.displayName,
    displayOwner: row.displayOwner,
    githubInstallationId: row.githubInstallationId,
    githubRepositoryId: row.githubRepositoryId,
    id: parseRepositoryTargetBindingId(row.id),
    integrationTargetId: parseIntegrationTargetId(row.integrationTargetId),
    lastVerifiedAtMs: toUnixMilliseconds(row.lastVerifiedAt.getTime()),
    private: row.private,
    ...(row.githubNodeId === null ? {} : { githubNodeId: row.githubNodeId }),
    ...(row.repositoryAvailabilitySnapshotId === null
      ? {}
      : { repositoryAvailabilitySnapshotId: row.repositoryAvailabilitySnapshotId }),
  };
}

function mapPolicyRule(
  row: TargetWithRelationsRow["targetPolicyRules"][number],
): TargetPolicyRule {
  return {
    capability: assertCapability(row.capability),
    createdAtMs: toUnixMilliseconds(row.createdAt.getTime()),
    createdByDesktopClientId: parseDesktopClientIdOrThrow(row.createdByDesktopClientId),
    effect: assertEffect(row.effect),
    id: parseTargetPolicyRuleId(row.id),
    integrationTargetId: parseIntegrationTargetId(row.integrationTargetId),
    subjectId: row.subjectId,
    subjectKind: assertSubjectKind(row.subjectKind),
    workspaceId: parseWorkspaceIdOrThrow(row.workspaceId),
  };
}

function mapPolicyRuleInput(
  row: TargetWithRelationsRow["targetPolicyRules"][number],
): TargetPolicyRuleInput {
  return {
    capability: assertCapability(row.capability),
    effect: assertEffect(row.effect),
    subjectId: row.subjectId,
    subjectKind: assertSubjectKind(row.subjectKind),
  };
}

function mapRepositorySyncStatus(
  cursors: readonly { cursorKind: string; cursorValue: string | null; status: string }[],
) {
  const cursor = cursors.find(
    (item) => item.cursorKind === "github_installation_repositories",
  );
  return {
    complete: cursor?.status === "completed",
    ...(cursor?.cursorValue === null || cursor?.cursorValue === undefined
      ? {}
      : { nextCursor: cursor.cursorValue }),
  };
}

function matchesAvailabilityFilters(
  repository: RepositoryAvailabilityView,
  filters: Parameters<
    IntegrationTargetRepository["listAvailableRepositories"]
  >[0]["filters"],
): boolean {
  if (filters?.available !== undefined && repository.available !== filters.available) {
    return false;
  }
  if (filters?.archived !== undefined && repository.archived !== filters.archived) {
    return false;
  }
  if (
    filters?.targetStatus !== undefined &&
    repository.target?.status !== filters.targetStatus
  ) {
    return false;
  }
  return true;
}

function applyPagination<T>(
  items: readonly T[],
  pagination: Parameters<
    IntegrationTargetRepository["listAvailableRepositories"]
  >[0]["pagination"],
): readonly T[] {
  if (pagination === undefined) {
    return items;
  }
  return items.slice(pagination.offset, pagination.offset + pagination.limit);
}

function parseWorkspaceIdOrThrow(value: string) {
  const workspaceId = parseWorkspaceId(value);
  if (!workspaceId.ok) {
    throw workspaceId.error;
  }
  return workspaceId.value;
}

function parseIntegrationConnectionIdOrThrow(value: string) {
  const connectionId = parseIntegrationConnectionId(value);
  if (!connectionId.ok) {
    throw connectionId.error;
  }
  return connectionId.value;
}

function parseDesktopClientIdOrThrow(value: string) {
  const desktopClientId = parseDesktopClientId(value);
  if (!desktopClientId.ok) {
    throw desktopClientId.error;
  }
  return desktopClientId.value;
}

function assertTargetStatus(value: string): IntegrationTargetStatus {
  if (
    value === "enabled" ||
    value === "disabled" ||
    value === "stale" ||
    value === "revoked" ||
    value === "deleted"
  ) {
    return value;
  }
  throw new Error(`Unknown integration target status ${value}`);
}

function assertConnectionStatus(value: string): "active" | "suspended" | "deleted" {
  if (value === "active" || value === "suspended" || value === "deleted") {
    return value;
  }
  throw new Error(`Unknown integration connection status ${value}`);
}

function assertCapability(value: string): TargetPolicyRuleInput["capability"] {
  if (
    value === "github.issue_comment.request" ||
    value === "github.pr_comment.request" ||
    value === "github.pr_review.request" ||
    value === "github.check_run.request"
  ) {
    return value;
  }
  throw new Error(`Unknown target policy capability ${value}`);
}

function assertEffect(value: string): TargetPolicyRuleInput["effect"] {
  if (value === "allow" || value === "deny") {
    return value;
  }
  throw new Error(`Unknown target policy effect ${value}`);
}

function assertSubjectKind(value: string): TargetPolicyRuleInput["subjectKind"] {
  if (
    value === "workspace" ||
    value === "team" ||
    value === "agent" ||
    value === "desktop_client"
  ) {
    return value;
  }
  throw new Error(`Unknown target policy subject kind ${value}`);
}

function revalidationRequiredError(): SafeError {
  return createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_REPOSITORY_REVALIDATION_REQUIRED",
    message: "Repository availability must be revalidated before enabling this target.",
  });
}

function targetNotFoundError(): SafeError {
  return createSafeError({
    category: "not-found",
    code: "CONTROL_PLANE_TARGET_NOT_FOUND",
    message: "Repository target was not found.",
  });
}
