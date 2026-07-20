import {
  type CommandDescriptorRegistry,
  createDurableCommandDescriptorIdentity,
  createInitialEffectPlan,
} from '../../../core/domain';

import type {
  ApplicationCommandLedgerBeginRequest,
  ApplicationCommandLedgerBeginResult,
  ApplicationCommandLedgerCompleteRequest,
  ApplicationCommandLedgerFailRequest,
  ApplicationCommandLedgerListScopeRequest,
  ApplicationCommandLedgerReadByCommandIdRequest,
  ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  ApplicationCommandLedgerRecord,
} from '../../../contracts';
import type {
  ApplicationCommandLedgerStorageGateway,
  ApplicationCommandLedgerStore,
  DurableApplicationCommandAttemptLeaseRequest,
  DurableApplicationCommandClaimRequest,
  DurableApplicationCommandClaimResult,
  DurableApplicationCommandClaimStatusRequest,
  DurableApplicationCommandCommitRequest,
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerApplyResult,
  DurableApplicationCommandConsumerProjectionRecord,
  DurableApplicationCommandConsumerProjectionRequest,
  DurableApplicationCommandEffectTransitionRequest,
  DurableApplicationCommandLedgerStorageGateway,
  DurableApplicationCommandLedgerStore,
  DurableApplicationCommandOutboxClaimRequest,
  DurableApplicationCommandOutboxDeliveryAcknowledgementRequest,
  DurableApplicationCommandOutboxListRequest,
  DurableApplicationCommandOutboxRecord,
  DurableApplicationCommandRecord,
  DurableApplicationCommandStatusRequest,
  DurableApplicationCommandTransitionRequest,
} from '../../../core/application';

type CompatibleApplicationCommandLedgerGateway = ApplicationCommandLedgerStorageGateway &
  Partial<DurableApplicationCommandLedgerStorageGateway>;

export class InternalStorageApplicationCommandLedgerStore
  implements ApplicationCommandLedgerStore, DurableApplicationCommandLedgerStore
{
  constructor(
    private readonly gateway: CompatibleApplicationCommandLedgerGateway,
    private readonly descriptorRegistry: CommandDescriptorRegistry | null = null
  ) {}

  begin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>> {
    return this.gateway.applicationCommandLedgerBegin(request);
  }

  markCompleted(request: ApplicationCommandLedgerCompleteRequest): Promise<void> {
    return this.gateway.applicationCommandLedgerMarkCompleted(request);
  }

  markFailed(request: ApplicationCommandLedgerFailRequest): Promise<void> {
    return this.gateway.applicationCommandLedgerMarkFailed(request);
  }

  getByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return this.gateway.applicationCommandLedgerGetByCommandId(request);
  }

  getByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return this.gateway.applicationCommandLedgerGetByIdempotencyKey(request);
  }

  listByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]> {
    return this.gateway.applicationCommandLedgerListByScope(request);
  }

  async claimDurable<TCommandKind extends string>(
    request: DurableApplicationCommandClaimRequest<TCommandKind>
  ): Promise<DurableApplicationCommandClaimResult<TCommandKind>> {
    const registry = this.requireDescriptorRegistry();
    const descriptor = registry.resolveFingerprintRecord<unknown, TCommandKind>(
      request.scope.commandKind,
      request.fingerprint
    );
    const existing = await this.requireDurableMethod(
      'applicationCommandLedgerDurableGetByClaim'
    )<TCommandKind>({ scope: request.scope });
    if (existing) this.assertRegisteredRecord(existing);
    const result = await this.requireDurableMethod('applicationCommandLedgerDurableClaim')({
      ...request,
      descriptor: createDurableCommandDescriptorIdentity(descriptor),
      retentionClass: descriptor.retentionClass,
      effectPlan: createInitialEffectPlan(descriptor),
    });
    this.assertRegisteredRecord(result.command);
    return result;
  }

  async getDurableStatus<TCommandKind extends string>(
    request: DurableApplicationCommandStatusRequest
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null> {
    const record = await this.requireDurableMethod(
      'applicationCommandLedgerDurableGetStatus'
    )<TCommandKind>(request);
    if (record) this.assertRegisteredRecord(record);
    return record;
  }

  async getDurableByClaim<TCommandKind extends string>(
    request: DurableApplicationCommandClaimStatusRequest<TCommandKind>
  ): Promise<DurableApplicationCommandRecord<TCommandKind> | null> {
    const record = await this.requireDurableMethod(
      'applicationCommandLedgerDurableGetByClaim'
    )<TCommandKind>(request);
    if (record) this.assertRegisteredRecord(record);
    return record;
  }

  async renewDurableAttemptLease(
    request: DurableApplicationCommandAttemptLeaseRequest
  ): Promise<DurableApplicationCommandRecord> {
    await this.assertRegisteredMutationTarget(request);
    const record = await this.requireDurableMethod(
      'applicationCommandLedgerDurableRenewAttemptLease'
    )(request);
    this.assertRegisteredRecord(record);
    return record;
  }

  async transitionDurableCommand(
    request: DurableApplicationCommandTransitionRequest
  ): Promise<DurableApplicationCommandRecord> {
    await this.assertRegisteredMutationTarget(request);
    const record = await this.requireDurableMethod(
      'applicationCommandLedgerDurableTransitionCommand'
    )(request);
    this.assertRegisteredRecord(record);
    return record;
  }

  async transitionDurableEffect(
    request: DurableApplicationCommandEffectTransitionRequest
  ): Promise<DurableApplicationCommandRecord> {
    await this.assertRegisteredMutationTarget(request);
    const record = await this.requireDurableMethod(
      'applicationCommandLedgerDurableTransitionEffect'
    )(request);
    this.assertRegisteredRecord(record);
    return record;
  }

  async commitDurable(
    request: DurableApplicationCommandCommitRequest
  ): Promise<DurableApplicationCommandRecord> {
    await this.assertRegisteredMutationTarget(request);
    const record = await this.requireDurableMethod('applicationCommandLedgerDurableCommit')(
      request
    );
    this.assertRegisteredRecord(record);
    return record;
  }

  listDurableOutbox(
    request: DurableApplicationCommandOutboxListRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]> {
    return this.requireDurableMethod('applicationCommandLedgerDurableListOutbox')(request);
  }

  claimDurableOutbox(
    request: DurableApplicationCommandOutboxClaimRequest
  ): Promise<DurableApplicationCommandOutboxRecord[]> {
    return this.requireDurableMethod('applicationCommandLedgerDurableClaimOutbox')(request);
  }

  acknowledgeDurableOutboxDelivery(
    request: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
  ): Promise<void> {
    return this.requireDurableMethod('applicationCommandLedgerDurableAcknowledgeOutboxDelivery')(
      request
    );
  }

  applyDurableConsumerEvent(
    request: DurableApplicationCommandConsumerApplyRequest
  ): Promise<DurableApplicationCommandConsumerApplyResult> {
    return this.requireDurableMethod('applicationCommandLedgerDurableApplyConsumerEvent')(request);
  }

  getDurableConsumerProjection(
    request: DurableApplicationCommandConsumerProjectionRequest
  ): Promise<DurableApplicationCommandConsumerProjectionRecord | null> {
    return this.requireDurableMethod('applicationCommandLedgerDurableGetConsumerProjection')(
      request
    );
  }

  private requireDescriptorRegistry(): CommandDescriptorRegistry {
    if (!this.descriptorRegistry) {
      throw new Error(
        'Durable application command persistence requires a checked-in command descriptor registry'
      );
    }
    return this.descriptorRegistry;
  }

  private async assertRegisteredMutationTarget(request: {
    deploymentId: string;
    commandId: string;
  }): Promise<void> {
    const record = await this.requireDurableMethod('applicationCommandLedgerDurableGetStatus')(
      request
    );
    if (!record) {
      throw new Error(`Durable application command not found: ${request.commandId}`);
    }
    this.assertRegisteredRecord(record);
  }

  private requireDurableMethod<TKey extends keyof DurableApplicationCommandLedgerStorageGateway>(
    key: TKey
  ): DurableApplicationCommandLedgerStorageGateway[TKey] {
    const method = this.gateway[key];
    if (typeof method !== 'function') {
      throw new Error(`Internal storage does not support durable application commands: ${key}`);
    }
    return method.bind(this.gateway) as DurableApplicationCommandLedgerStorageGateway[TKey];
  }

  private assertRegisteredRecord(record: DurableApplicationCommandRecord): void {
    const registry = this.requireDescriptorRegistry();
    const descriptor = registry.resolveFingerprintRecord(
      record.claim.scope.commandKind,
      record.claim.fingerprint
    );
    const expectedIdentity = createDurableCommandDescriptorIdentity(descriptor);
    if (record.retentionClass !== descriptor.retentionClass) {
      throw new Error('Persisted durable command retention class mismatch');
    }
    for (const key of [
      'descriptorId',
      'descriptorVersion',
      'commandKind',
      'inputSchemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
    ] as const) {
      if (expectedIdentity[key] !== record.descriptor[key]) {
        throw new Error(`Persisted durable command descriptor mismatch: ${key}`);
      }
    }
    const expectedPlan = createInitialEffectPlan(descriptor);
    if (expectedPlan.length !== record.effects.length) {
      throw new Error('Persisted durable command effect plan length mismatch');
    }
    for (let ordinal = 0; ordinal < expectedPlan.length; ordinal += 1) {
      const expected = expectedPlan[ordinal];
      const actual = record.effects[ordinal];
      for (const key of [
        'effectId',
        'effectVersion',
        'recoveryClass',
        'evidenceSchemaVersion',
        'ordinal',
      ] as const) {
        if (expected[key] !== actual[key]) {
          throw new Error(`Persisted durable command effect plan mismatch: ${ordinal}.${key}`);
        }
      }
    }
  }
}
