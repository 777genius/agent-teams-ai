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
      await withTimeout(
        this.getClient().$queryRaw<readonly { ready: number }[]>`SELECT 1 AS ready`,
        input.timeoutMs ?? 1000,
      );

      return {
        enabled: true,
        migrationStatus: "not-checked",
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
