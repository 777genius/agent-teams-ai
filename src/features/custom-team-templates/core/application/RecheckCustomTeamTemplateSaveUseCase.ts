import { checkStoredTemplate } from './reconcileCustomTeamTemplateWrite';

import type { InMemoryCustomTeamTemplatePreviewStore } from './InMemoryCustomTeamTemplatePreviewStore';
import type { CustomTeamTemplateHasher, CustomTeamTemplateStorageGateway } from './ports';
import type {
  CustomTeamTemplateValidationIssue,
  RecheckCustomTeamTemplateSaveResult,
} from '@features/custom-team-templates/contracts';

export interface RecheckCustomTeamTemplateSaveUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
  hasher: CustomTeamTemplateHasher;
  previewStore: InMemoryCustomTeamTemplatePreviewStore;
}

function parsePreviewToken(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const raw = (payload as { previewToken?: unknown }).previewToken;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Re-checks a save whose outcome stayed unresolved, without writing anything.
 *
 * Nothing is accepted from the caller except the opaque preview token: the
 * stable template id, the confirmed display identity and the content digest all
 * come from the retained operation, so a caller can never assert a record,
 * a digest or a successful write. The read is by that stable id, which means a
 * re-check can only ever describe the operation it was issued for.
 *
 * Every answer stays honest. A read of an absent or conflicting current row
 * does not prove that this earlier operation never committed: the original
 * writer may still be retrying or another editor may have changed the row.
 * Therefore only a positive identity match settles a confirmed operation;
 * other outcomes remain unresolved until independent durable evidence or an
 * explicit user decision. A never-confirmed preview is `notSaved` without
 * any storage read. Re-check never dispatches a write.
 */
export class RecheckCustomTeamTemplateSaveUseCase {
  constructor(private readonly deps: RecheckCustomTeamTemplateSaveUseCaseDeps) {}

  async execute(payload: unknown): Promise<RecheckCustomTeamTemplateSaveResult> {
    const token = parsePreviewToken(payload);
    if (!token) {
      return validationFailed([{ code: 'previewTokenRequired', field: 'previewToken' }]);
    }

    const resolution = this.deps.previewStore.resolve(token);
    if (resolution.status === 'unknown') {
      return validationFailed([{ code: 'previewTokenUnknown', field: 'previewToken' }]);
    }
    // If expired but has a confirmed save, use the preserved identity for re-check.
    // If expired without a confirmed save, the preview is truly gone.
    let state: typeof resolution.state;
    if (resolution.status === 'expired') {
      if (resolution.state?.confirmedSave) {
        state = resolution.state;
      } else {
        return validationFailed([{ code: 'previewTokenExpired', field: 'previewToken' }]);
      }
    } else {
      state = resolution.state;
    }

    // A preview that was never confirmed has never dispatched a save.
    // Do not classify a matching row from some other operation as our success.
    if (!state.confirmedSave) {
      return { status: 'notSaved', templateId: state.templateId };
    }

    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    const check = await checkStoredTemplate(
      gateway,
      {
        templateId: state.templateId,
        name: state.name,
        description: state.description,
        contentHash: state.contentHash,
      },
      this.deps.hasher
    );

    switch (check.status) {
      case 'saved':
        this.deps.previewStore.clearUnresolvedWrite(token);
        return { status: 'saved', template: check.template };
      case 'conflict':
      case 'absent':
        // A queued read can run before an earlier busy writer's retry, and a
        // successfully created row can subsequently be edited or deleted.
        // Neither the current row nor its absence proves the original save
        // failed. Preserve the operation fence until a positive identity
        // match (or an independently durable settlement record) exists.
        return { status: 'unresolved', templateId: check.templateId };
      case 'unresolved':
        return { status: 'unresolved', templateId: check.templateId };
    }
  }
}

function validationFailed(
  issues: readonly CustomTeamTemplateValidationIssue[]
): RecheckCustomTeamTemplateSaveResult {
  return { status: 'validationFailed', issues };
}
