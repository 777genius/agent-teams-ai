import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  getPrismaTransactionClient,
  PRISMA_DATABASE_CLIENT,
  type PrismaDatabaseClient,
} from "@agent-teams-control-plane/platform-database";

import type { IntegrationTargetsAuditLog } from "../../application/ports/policies.js";
import type { TransactionContext } from "../../application/ports/transaction-runner.js";

@Injectable()
export class PrismaIntegrationTargetAuditLog implements IntegrationTargetsAuditLog {
  public constructor(
    @Inject(PRISMA_DATABASE_CLIENT)
    private readonly databaseClient: PrismaDatabaseClient,
  ) {}

  public async record(
    input: Parameters<IntegrationTargetsAuditLog["record"]>[0],
    context?: TransactionContext,
  ): Promise<void> {
    if (!this.databaseClient.isEnabled()) {
      return;
    }
    const workspaceId = input.workspaceId ?? input.actor?.workspaceId;
    const client =
      context === undefined
        ? this.databaseClient.getClient()
        : getPrismaTransactionClient(context);
    await client.auditEvent.create({
      data: {
        actorKind: input.actor === undefined ? "system" : "desktop_client",
        eventType: input.eventType,
        id: randomUUID(),
        safeMetadataJson: input.safeMetadata ?? {},
        ...(input.actor === undefined ? {} : { actorId: input.actor.desktopClientId }),
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        ...(input.subjectKind === undefined ? {} : { subjectKind: input.subjectKind }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
    });
  }
}
