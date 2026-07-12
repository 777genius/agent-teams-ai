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
} from '../../../core/application';

export class InternalStorageApplicationCommandLedgerStore implements ApplicationCommandLedgerStore {
  constructor(private readonly gateway: ApplicationCommandLedgerStorageGateway) {}

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
}
