import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { serializeCanonicalTemplateContent } from '../domain/canonicalTemplateSerialization';
import { validateTemplateName } from '../domain/templateNamePolicy';

import type { CustomTeamTemplateHasher, CustomTeamTemplateStorageGateway } from './ports';
import type {
  CustomTeamTemplateValidationIssue,
  DuplicateCustomTeamTemplateRequest,
  DuplicateCustomTeamTemplateResult,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

export interface DuplicateCustomTeamTemplateUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
  hasher: CustomTeamTemplateHasher;
  /** Fresh stable id for the new copy. Must be unpredictable. */
  createTemplateId: () => string;
}

const MAX_CREATE_ATTEMPTS = 2;

/**
 * Duplicates one custom template under a new name (A3).
 *
 * Creates a brand-new record with a fresh stable id, copying only the
 * approved template fields (name/description/prompt/members) — never database
 * ids, transient preview tokens or source-team runtime metadata. The source
 * record is never modified. Name conflicts surface actionably instead of
 * overwriting. This is distinct from the existing Copy-team feature (which
 * copies a live team into the creation form, not a template into the
 * library).
 */
export class DuplicateCustomTeamTemplateUseCase {
  constructor(private readonly deps: DuplicateCustomTeamTemplateUseCaseDeps) {}

  async execute(payload: unknown): Promise<DuplicateCustomTeamTemplateResult> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return failed([{ code: 'templateNameRequired', field: 'name' }]);
    }
    const candidate = payload as { sourceTemplateId?: unknown; name?: unknown };
    const sourceId =
      typeof candidate.sourceTemplateId === 'string' ? candidate.sourceTemplateId : '';
    if (!sourceId.trim()) {
      return { status: 'sourceNotFound', sourceTemplateId: sourceId };
    }
    const nameValidation = validateTemplateName(candidate.name);
    if (!nameValidation.valid) {
      return failed(nameValidation.issues);
    }

    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    let source: CustomTeamTemplateV1;
    try {
      const read = await gateway.customTeamTemplateGetById({ templateId: sourceId });
      if (read.status === 'notFound') {
        return { status: 'sourceNotFound', sourceTemplateId: sourceId };
      }
      if (read.status === 'unreadable') {
        return { status: 'sourceUnreadable', sourceTemplateId: sourceId };
      }
      source = read.template;
    } catch {
      return { status: 'storageUnavailable' };
    }

    const canonical = serializeCanonicalTemplateContent({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: source.teamPrompt,
      members: source.members,
    });
    const contentHash = this.deps.hasher.hashCanonicalContent(canonical);

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const templateId = this.deps.createTemplateId();
      let result;
      try {
        result = await gateway.customTeamTemplateCreate({
          template: {
            templateId,
            name: nameValidation.value,
            ...(source.description ? { description: source.description } : {}),
            schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
            teamPrompt: source.teamPrompt,
            members: source.members,
          },
          contentHash,
        });
      } catch {
        return { status: 'storageUnavailable' };
      }
      switch (result.status) {
        case 'created':
          return {
            status: 'duplicated',
            template: { ...result.template, revision: result.template.revision ?? 1 },
          };
        case 'alreadySaved':
          return {
            status: 'duplicated',
            template: { ...result.template, revision: result.template.revision ?? 1 },
          };
        case 'conflict':
          if (result.reason === 'nameTaken') {
            return { status: 'nameConflict', existingTemplateId: result.existingTemplateId };
          }
          if (attempt + 1 < MAX_CREATE_ATTEMPTS) {
            break;
          }
          return { status: 'templateIdConflict', templateId: result.existingTemplateId };
        case 'existingRecordUnreadable':
          return { status: 'storageUnavailable' };
        case 'retryable':
          if (attempt + 1 < MAX_CREATE_ATTEMPTS) {
            break;
          }
          return { status: 'storageUnavailable' };
      }
    }
    return { status: 'storageUnavailable' };
  }
}

function failed(
  issues: readonly CustomTeamTemplateValidationIssue[]
): DuplicateCustomTeamTemplateResult {
  return { status: 'validationFailed', issues };
}

export type { DuplicateCustomTeamTemplateRequest };
