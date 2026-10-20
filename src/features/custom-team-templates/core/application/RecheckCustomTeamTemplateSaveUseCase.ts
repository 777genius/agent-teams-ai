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
 * Every answer stays honest. `notSaved` is confirmed absence (no record exists
 * for the id, so retrying the same operation is safe) and is never returned when
 * a record exists but cannot be reconstructed; `unresolved` covers exactly that
 * case, so a damaged row can never be read as a missing one. No write is
 * attempted at all, so re-checking cannot create a second row or replace a
 * conflicting one.
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
        this.deps.previewStore.clearUnresolvedWrite(token);
        return { status: 'templateIdConflict', templateId: check.templateId };
      case 'absent':
        return { status: 'notSaved', templateId: check.templateId };
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
