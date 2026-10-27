import { CustomTeamTemplateStorageInterruptedError } from './CustomTeamTemplateStorageInterruptedError';
import { waitForStorageSettlement } from './waitForStorageSettlement';

import type { CustomTeamTemplateStorageGateway } from './ports';
import type {
  DeleteCustomTeamTemplateRequest,
  DeleteCustomTeamTemplateResult,
} from '@features/custom-team-templates/contracts';

export interface DeleteCustomTeamTemplateUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
}

/**
 * Deletes one custom template record (A3).
 *
 * Deletes exactly the selected record via a worker-side compare-and-swap
 * against `expectedRevision`: a stale selection deleting a newer edit gets
 * `revisionConflict` with the current state instead of deleting it. There is
 * no cascade — teams already created from the template live outside this
 * table and stay usable and unchanged. Built-in templates can never reach
 * this use case (they live in the static catalogue, not in this store).
 */
export class DeleteCustomTeamTemplateUseCase {
  constructor(private readonly deps: DeleteCustomTeamTemplateUseCaseDeps) {}

  async execute(payload: unknown): Promise<DeleteCustomTeamTemplateResult> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { status: 'notFound', templateId: '' };
    }
    const candidate = payload as { templateId?: unknown; expectedRevision?: unknown };
    if (typeof candidate.templateId !== 'string' || !candidate.templateId.trim()) {
      return { status: 'notFound', templateId: '' };
    }
    if (
      typeof candidate.expectedRevision !== 'number' ||
      !Number.isInteger(candidate.expectedRevision)
    ) {
      return { status: 'notFound', templateId: candidate.templateId };
    }

    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    let hadUnknownExecution = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result;
      try {
        result = await gateway.customTeamTemplateDelete({
          templateId: candidate.templateId,
          expectedRevision: candidate.expectedRevision,
        });
      } catch (error) {
        if (error instanceof CustomTeamTemplateStorageInterruptedError) {
          const settlement = await waitForStorageSettlement(error.settled);
          if (error.execution === 'not_started') {
            if (settlement === 'settled') {
              continue;
            }
            if (hadUnknownExecution) {
              return { status: 'unresolvedWriteOutcome', templateId: candidate.templateId };
            }
            return { status: 'storageUnavailable' };
          }
          hadUnknownExecution = true;
          try {
            const read = await gateway.customTeamTemplateGetById({
              templateId: candidate.templateId,
            });
            if (read.status === 'notFound') {
              return { status: 'deleted', templateId: candidate.templateId };
            }
            if (read.status === 'unreadable') {
              return { status: 'unresolvedWriteOutcome', templateId: candidate.templateId };
            }
          } catch {
            // fall through
          }
          return { status: 'unresolvedWriteOutcome', templateId: candidate.templateId };
        }
        if (hadUnknownExecution) {
          return { status: 'unresolvedWriteOutcome', templateId: candidate.templateId };
        }
        return { status: 'storageUnavailable' };
      }

      switch (result.status) {
        case 'deleted':
          return { status: 'deleted', templateId: result.templateId };
        case 'revisionConflict':
          return { status: 'revisionConflict', current: result.current };
        case 'notFound':
          return { status: 'notFound', templateId: result.templateId };
        case 'unreadable':
          return { status: 'unreadableRecord', templateId: result.templateId };
        case 'retryable':
          if (attempt + 1 < 2) {
            continue;
          }
          if (hadUnknownExecution) {
            return { status: 'unresolvedWriteOutcome', templateId: candidate.templateId };
          }
          return { status: 'storageUnavailable' };
      }
    }
    if (hadUnknownExecution) {
      return { status: 'unresolvedWriteOutcome', templateId: candidate.templateId };
    }
    return { status: 'storageUnavailable' };
  }
}

export type { DeleteCustomTeamTemplateRequest };
