import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';

import { CustomTeamTemplateStorageInterruptedError } from '../../../core/application/CustomTeamTemplateStorageInterruptedError';

import type {
  CreateCustomTeamTemplateRecordRequest,
  CreateCustomTeamTemplateRecordResult,
  DeleteCustomTeamTemplateRecordRequest,
  DeleteCustomTeamTemplateRecordResult,
  ListCustomTeamTemplateRecordsResult,
  ReadCustomTeamTemplateRecordRequest,
  ReadCustomTeamTemplateRecordResult,
  UpdateCustomTeamTemplateRecordRequest,
  UpdateCustomTeamTemplateRecordResult,
} from '../../../contracts';
import type { CustomTeamTemplateStorageGateway } from '../../../core/application/ports';

/**
 * Classifies worker interruptions at the port boundary.
 *
 * The internal-storage worker client signals a call it cannot confirm with its
 * own error class, which lives in that feature's runtime layer. Application use
 * cases must stay free of another feature's runtime errors, so composition
 * wraps the Phase 2A gateway with this adapter: every interruption becomes a
 * `CustomTeamTemplateStorageInterruptedError` carrying the same
 * `execution`/`settled` contract, and every other rejection passes through
 * untouched.
 */
export class InterruptionClassifyingCustomTeamTemplateStorageGateway implements CustomTeamTemplateStorageGateway {
  constructor(private readonly inner: CustomTeamTemplateStorageGateway) {}

  customTeamTemplateCreate(
    request: CreateCustomTeamTemplateRecordRequest
  ): Promise<CreateCustomTeamTemplateRecordResult> {
    return this.classify(() => this.inner.customTeamTemplateCreate(request));
  }

  customTeamTemplateList(): Promise<ListCustomTeamTemplateRecordsResult> {
    return this.classify(() => this.inner.customTeamTemplateList());
  }

  customTeamTemplateGetById(
    request: ReadCustomTeamTemplateRecordRequest
  ): Promise<ReadCustomTeamTemplateRecordResult> {
    return this.classify(() => this.inner.customTeamTemplateGetById(request));
  }

  customTeamTemplateUpdate(
    request: UpdateCustomTeamTemplateRecordRequest
  ): Promise<UpdateCustomTeamTemplateRecordResult> {
    return this.classify(() => this.inner.customTeamTemplateUpdate(request));
  }

  customTeamTemplateDelete(
    request: DeleteCustomTeamTemplateRecordRequest
  ): Promise<DeleteCustomTeamTemplateRecordResult> {
    return this.classify(() => this.inner.customTeamTemplateDelete(request));
  }

  private async classify<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof InternalStorageOperationInterruptedError) {
        throw new CustomTeamTemplateStorageInterruptedError(
          error.message,
          error.execution,
          error.settled,
          error
        );
      }
      throw error;
    }
  }
}
