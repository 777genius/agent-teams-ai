import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";

import { ControlPlaneConfigService } from "@agent-teams-control-plane/platform-config";
import {
  CONTROL_PLANE_LOGGER,
  type ControlPlaneLogger,
} from "@agent-teams-control-plane/platform-logger";

import { PrismaClient } from "../generated/prisma/client.js";
import type { DatabaseReadinessReport } from "../readiness/database-readiness.js";
import { buildPostgresPoolConfig } from "./postgres-pool-config.js";

export type PrismaClientLike = PrismaClient;
export type PrismaTransactionClientLike = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$extends" | "$on" | "$transaction" | "$use"
>;

const readinessTimeoutErrorCode = "CONTROL_PLANE_DATABASE_READINESS_TIMEOUT";
const readinessUnavailableErrorCode = "CONTROL_PLANE_DATABASE_UNAVAILABLE";
const migrationsMissingErrorCode = "CONTROL_PLANE_DATABASE_MIGRATIONS_MISSING";
const requiredMigrationTables = [
  "audit_events",
  "dead_letter_events",
  "desktop_client_credentials",
  "desktop_clients",
  "desktop_pairing_sessions",
  "distributed_locks",
  "external_action_content_key_refs",
  "external_action_contents",
  "github_installation_claims",
  "github_installation_snapshots",
  "github_oauth_claim_sessions",
  "github_repository_snapshots",
  "github_setup_sessions",
  "github_unclaimed_installation_callbacks",
  "integration_connections",
  "github_repository_target_bindings",
  "integration_targets",
  "outbox_events",
  "provider_account_snapshots",
  "provider_repository_availability",
  "provider_repository_sync_cursors",
  "target_policy_rules",
  "workspaces",
] as const;

@Injectable()
export class PrismaDatabaseClient implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger: ControlPlaneLogger;
  private client: PrismaClientLike | undefined;

  public constructor(
    @Inject(ControlPlaneConfigService)
    private readonly configService: ControlPlaneConfigService,
    @Inject(CONTROL_PLANE_LOGGER) logger: ControlPlaneLogger,
  ) {
    this.logger = logger.child("database");
  }

  public isEnabled(): boolean {
    return this.configService.getConfig().persistence.enabled;
  }

  public getClient(): PrismaClientLike {
    if (!this.isEnabled()) {
      throw new Error("Database client requested while persistence is disabled.");
    }

    if (this.client === undefined) {
      const database = this.configService.getConfig().database;
      this.client = new PrismaClient({
        adapter: new PrismaPg(buildPostgresPoolConfig(database)),
        errorFormat: "minimal",
      });
    }

    return this.client;
  }

  public async connect(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.info("Database disabled by configuration");
      return;
    }

    await this.getClient().$connect();
    this.logger.info("Database connected", {
      poolMax: this.configService.getSafeSummary().database.poolMax,
      sslMode: this.configService.getSafeSummary().database.sslMode,
    });
  }

  public async onApplicationBootstrap(): Promise<void> {
    await this.connect();
  }

  public async disconnect(): Promise<void> {
    if (this.client === undefined) {
      return;
    }

    await this.client.$disconnect();
    this.client = undefined;
  }

  public async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  public async check(
    input: { timeoutMs?: number } = {},
  ): Promise<DatabaseReadinessReport> {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        migrationStatus: "not-checked",
        status: "disabled",
      };
    }

    try {
      const timeoutMs = input.timeoutMs ?? 1000;
      await withTimeout(
        this.getClient().$queryRaw<readonly { ready: number }[]>`SELECT 1 AS ready`,
        timeoutMs,
      );
      const migrationStatus = await withTimeout(this.checkMigrationStatus(), timeoutMs);

      if (migrationStatus === "missing") {
        return {
          enabled: true,
          migrationStatus,
          reasonCode: migrationsMissingErrorCode,
          status: "unavailable",
        };
      }

      return {
        enabled: true,
        migrationStatus,
        status: "ready",
      };
    } catch (error) {
      const reasonCode =
        error instanceof DatabaseReadinessTimeoutError
          ? readinessTimeoutErrorCode
          : readinessUnavailableErrorCode;
      this.logger.warn("Database readiness check failed", { reasonCode });

      return {
        enabled: true,
        migrationStatus: "not-checked",
        reasonCode,
        status: "unavailable",
      };
    }
  }

  private async checkMigrationStatus(): Promise<"applied" | "missing"> {
    const rows = await this.getClient().$queryRaw<
      readonly { table_name: string | null }[]
    >`
      SELECT to_regclass('public.audit_events')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.dead_letter_events')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.desktop_client_credentials')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.desktop_clients')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.desktop_pairing_sessions')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.distributed_locks')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.external_action_content_key_refs')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.external_action_contents')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.github_installation_claims')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.github_installation_snapshots')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.github_oauth_claim_sessions')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.github_repository_snapshots')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.github_setup_sessions')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.github_unclaimed_installation_callbacks')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.github_repository_target_bindings')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.integration_connections')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.integration_targets')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.outbox_events')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.provider_account_snapshots')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.provider_repository_availability')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.provider_repository_sync_cursors')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.target_policy_rules')::text AS table_name
      UNION ALL
      SELECT to_regclass('public.workspaces')::text AS table_name
    `;
    const existingTables = new Set(
      rows.flatMap((row) => (row.table_name === null ? [] : [row.table_name])),
    );

    return requiredMigrationTables.every((tableName) => existingTables.has(tableName))
      ? "applied"
      : "missing";
  }
}

class DatabaseReadinessTimeoutError extends Error {
  public constructor() {
    super("Database readiness check timed out.");
    this.name = "DatabaseReadinessTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new DatabaseReadinessTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
