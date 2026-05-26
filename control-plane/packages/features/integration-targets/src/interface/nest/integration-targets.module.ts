import { Module } from "@nestjs/common";

import { WorkspaceIdentityModule } from "@agent-teams-control-plane/features-workspace-identity/interface/nest";
import {
  ControlPlaneConfigService,
  PlatformConfigModule,
} from "@agent-teams-control-plane/platform-config";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner as PlatformTransactionRunner,
} from "@agent-teams-control-plane/platform-database";
import { PlatformDatabaseModule } from "@agent-teams-control-plane/platform-database/nest";

import type { IntegrationTargetRepository } from "../../application/ports/integration-target.repository.js";
import type {
  IntegrationTargetsAuditLog,
  IntegrationTargetsFeatureGatePolicy,
  IntegrationTargetsSettings,
} from "../../application/ports/policies.js";
import type { TransactionRunner } from "../../application/ports/transaction-runner.js";
import { DisableRepositoryTargetUseCase } from "../../application/use-cases/disable-repository-target.use-case.js";
import { EnableRepositoryTargetUseCase } from "../../application/use-cases/enable-repository-target.use-case.js";
import { EvaluateTargetPolicyUseCase } from "../../application/use-cases/evaluate-target-policy.use-case.js";
import { GetRepositoryTargetUseCase } from "../../application/use-cases/get-repository-target.use-case.js";
import { ListAvailableRepositoryTargetsUseCase } from "../../application/use-cases/list-available-repository-targets.use-case.js";
import { ListRepositoryTargetsUseCase } from "../../application/use-cases/list-repository-targets.use-case.js";
import { UpdateTargetPolicyUseCase } from "../../application/use-cases/update-target-policy.use-case.js";
import {
  ConfigIntegrationTargetsFeatureGatePolicy,
  ConfigIntegrationTargetsSettings,
} from "../../infrastructure/config/config-integration-targets.policy.js";
import { PrismaIntegrationTargetAuditLog } from "../../infrastructure/prisma/prisma-integration-target-audit-log.js";
import { PrismaIntegrationTargetRepository } from "../../infrastructure/prisma/prisma-integration-target.repository.js";
import { IntegrationTargetsController } from "./integration-targets.controller.js";
import {
  INTEGRATION_TARGET_AUDIT_LOG,
  INTEGRATION_TARGET_FEATURE_GATE_POLICY,
  INTEGRATION_TARGET_REPOSITORY,
  INTEGRATION_TARGET_SETTINGS,
} from "./tokens.js";

@Module({
  controllers: [IntegrationTargetsController],
  exports: [
    INTEGRATION_TARGET_REPOSITORY,
    EvaluateTargetPolicyUseCase,
    ListRepositoryTargetsUseCase,
  ],
  imports: [PlatformConfigModule, PlatformDatabaseModule, WorkspaceIdentityModule],
  providers: [
    PrismaIntegrationTargetRepository,
    PrismaIntegrationTargetAuditLog,
    {
      provide: INTEGRATION_TARGET_REPOSITORY,
      useExisting: PrismaIntegrationTargetRepository,
    },
    {
      provide: INTEGRATION_TARGET_AUDIT_LOG,
      useExisting: PrismaIntegrationTargetAuditLog,
    },
    {
      inject: [ControlPlaneConfigService],
      provide: INTEGRATION_TARGET_FEATURE_GATE_POLICY,
      useFactory: (configService: ControlPlaneConfigService) =>
        new ConfigIntegrationTargetsFeatureGatePolicy(configService),
    },
    {
      inject: [ControlPlaneConfigService],
      provide: INTEGRATION_TARGET_SETTINGS,
      useFactory: (configService: ControlPlaneConfigService) =>
        new ConfigIntegrationTargetsSettings(configService),
    },
    {
      inject: [INTEGRATION_TARGET_REPOSITORY, INTEGRATION_TARGET_FEATURE_GATE_POLICY],
      provide: ListAvailableRepositoryTargetsUseCase,
      useFactory: (
        repository: IntegrationTargetRepository,
        featureGate: IntegrationTargetsFeatureGatePolicy,
      ) => new ListAvailableRepositoryTargetsUseCase(repository, featureGate),
    },
    {
      inject: [INTEGRATION_TARGET_REPOSITORY, INTEGRATION_TARGET_FEATURE_GATE_POLICY],
      provide: ListRepositoryTargetsUseCase,
      useFactory: (
        repository: IntegrationTargetRepository,
        featureGate: IntegrationTargetsFeatureGatePolicy,
      ) => new ListRepositoryTargetsUseCase(repository, featureGate),
    },
    {
      inject: [INTEGRATION_TARGET_REPOSITORY, INTEGRATION_TARGET_FEATURE_GATE_POLICY],
      provide: GetRepositoryTargetUseCase,
      useFactory: (
        repository: IntegrationTargetRepository,
        featureGate: IntegrationTargetsFeatureGatePolicy,
      ) => new GetRepositoryTargetUseCase(repository, featureGate),
    },
    {
      inject: [
        INTEGRATION_TARGET_REPOSITORY,
        TRANSACTION_RUNNER,
        INTEGRATION_TARGET_FEATURE_GATE_POLICY,
        INTEGRATION_TARGET_SETTINGS,
        INTEGRATION_TARGET_AUDIT_LOG,
      ],
      provide: EnableRepositoryTargetUseCase,
      useFactory: (
        repository: IntegrationTargetRepository,
        transactionRunner: TransactionRunner & PlatformTransactionRunner,
        featureGate: IntegrationTargetsFeatureGatePolicy,
        settings: IntegrationTargetsSettings,
        auditLog: IntegrationTargetsAuditLog,
      ) =>
        new EnableRepositoryTargetUseCase(
          repository,
          transactionRunner,
          featureGate,
          settings,
          auditLog,
        ),
    },
    {
      inject: [
        INTEGRATION_TARGET_REPOSITORY,
        TRANSACTION_RUNNER,
        INTEGRATION_TARGET_FEATURE_GATE_POLICY,
        INTEGRATION_TARGET_AUDIT_LOG,
      ],
      provide: DisableRepositoryTargetUseCase,
      useFactory: (
        repository: IntegrationTargetRepository,
        transactionRunner: TransactionRunner & PlatformTransactionRunner,
        featureGate: IntegrationTargetsFeatureGatePolicy,
        auditLog: IntegrationTargetsAuditLog,
      ) =>
        new DisableRepositoryTargetUseCase(
          repository,
          transactionRunner,
          featureGate,
          auditLog,
        ),
    },
    {
      inject: [
        INTEGRATION_TARGET_REPOSITORY,
        TRANSACTION_RUNNER,
        INTEGRATION_TARGET_FEATURE_GATE_POLICY,
        INTEGRATION_TARGET_AUDIT_LOG,
      ],
      provide: UpdateTargetPolicyUseCase,
      useFactory: (
        repository: IntegrationTargetRepository,
        transactionRunner: TransactionRunner & PlatformTransactionRunner,
        featureGate: IntegrationTargetsFeatureGatePolicy,
        auditLog: IntegrationTargetsAuditLog,
      ) =>
        new UpdateTargetPolicyUseCase(
          repository,
          transactionRunner,
          featureGate,
          auditLog,
        ),
    },
    {
      inject: [
        INTEGRATION_TARGET_REPOSITORY,
        INTEGRATION_TARGET_FEATURE_GATE_POLICY,
        INTEGRATION_TARGET_SETTINGS,
      ],
      provide: EvaluateTargetPolicyUseCase,
      useFactory: (
        repository: IntegrationTargetRepository,
        featureGate: IntegrationTargetsFeatureGatePolicy,
        settings: IntegrationTargetsSettings,
      ) => new EvaluateTargetPolicyUseCase(repository, featureGate, settings),
    },
  ],
})
export class IntegrationTargetsModule {}
