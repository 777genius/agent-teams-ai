import { Global, Module } from "@nestjs/common";

import { PlatformConfigModule } from "@agent-teams-control-plane/platform-config";
import { PlatformLoggerModule } from "@agent-teams-control-plane/platform-logger";

import {
  DATABASE_READINESS_PROBE,
  DISTRIBUTED_LOCK_PORT,
  PRISMA_DATABASE_CLIENT,
  TRANSACTION_RUNNER,
} from "../tokens.js";
import { PrismaDistributedLockPort } from "../locks/prisma-distributed-lock.port.js";
import { PrismaDatabaseClient } from "../prisma/prisma-database-client.js";
import { PrismaTransactionRunner } from "../transaction/transaction-runner.js";

@Global()
@Module({
  exports: [
    PRISMA_DATABASE_CLIENT,
    TRANSACTION_RUNNER,
    DATABASE_READINESS_PROBE,
    DISTRIBUTED_LOCK_PORT,
  ],
  imports: [PlatformConfigModule, PlatformLoggerModule],
  providers: [
    PrismaDatabaseClient,
    {
      provide: PRISMA_DATABASE_CLIENT,
      useExisting: PrismaDatabaseClient,
    },
    {
      inject: [PrismaDatabaseClient],
      provide: TRANSACTION_RUNNER,
      useFactory: (databaseClient: PrismaDatabaseClient) =>
        new PrismaTransactionRunner(databaseClient),
    },
    {
      provide: DATABASE_READINESS_PROBE,
      useExisting: PrismaDatabaseClient,
    },
    {
      inject: [PrismaDatabaseClient],
      provide: DISTRIBUTED_LOCK_PORT,
      useFactory: (databaseClient: PrismaDatabaseClient) =>
        new PrismaDistributedLockPort(databaseClient),
    },
  ],
})
export class PlatformDatabaseModule {}
