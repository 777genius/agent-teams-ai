import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';

import { serializeCanonicalTemplateContent } from '../domain/canonicalTemplateSerialization';
import { validateTemplateContent } from '../domain/templateContentPolicy';
import { validateTemplateName } from '../domain/templateNamePolicy';

import { CustomTeamTemplateStorageInterruptedError } from './CustomTeamTemplateStorageInterruptedError';
import {
  checkStoredTemplate,
  type CustomTeamTemplateWriteIdentity,
} from './reconcileCustomTeamTemplateWrite';
import { waitForStorageSettlement } from './waitForStorageSettlement';

import type { CustomTeamTemplateHasher, CustomTeamTemplateStorageGateway } from './ports';
import type {
  CopyBuiltinTemplateRequest,
  CopyBuiltinTemplateResult,
  CustomTeamTemplateContentV1,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

export interface CopyBuiltinTemplateUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
  hasher: CustomTeamTemplateHasher;
  /**
   * Resolves one built-in template's allowlisted content, or null when the id
   * is unknown. Injected (rather than importing the catalogue) so the use
   * case stays unit-testable and the catalogue stays a renderer-safe module
   * the main process explicitly opts into.
   */
  resolveBuiltin: (id: string) => CustomTeamTemplateContentV1 | null;
  /** Fresh stable id for the new custom copy. Must be unpredictable. */
  createTemplateId: () => string;
}

const MAX_CREATE_ATTEMPTS = 2;

/**
 * Copies a built-in template into My Templates (A3).
 *
 * The built-in catalogue stays static and read-only: the use case only reads
 * the built-in content, then persists it as a brand-new custom template with
 * a fresh local id through the established idempotent create path. The copy
 * is independently editable and deletable; name conflicts never overwrite.
 */
export class CopyBuiltinTemplateUseCase {
  constructor(private readonly deps: CopyBuiltinTemplateUseCaseDeps) {}

  async execute(payload: unknown): Promise<CopyBuiltinTemplateResult> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return validationFailed([{ code: 'templateNameRequired', field: 'name' }]);
    }
    const candidate = payload as { builtinTemplateId?: unknown; name?: unknown };
    const builtinId =
      typeof candidate.builtinTemplateId === 'string' ? candidate.builtinTemplateId : '';
    const nameValidation = validateTemplateName(candidate.name);
    if (!nameValidation.valid) {
      return validationFailed(nameValidation.issues);
    }

    const content = this.deps.resolveBuiltin(builtinId);
    if (!content) {
      return { status: 'builtinNotFound', builtinTemplateId: builtinId };
    }
    const contentIssues = validateTemplateContent({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: content.teamPrompt,
      members: content.members,
    });
    if (contentIssues.length > 0) {
      return validationFailed(contentIssues);
    }

    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    const canonical = serializeCanonicalTemplateContent({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: content.teamPrompt,
      members: content.members,
    });
    const contentHash = this.deps.hasher.hashCanonicalContent(canonical);

    const templateId = this.deps.createTemplateId();
    let hadUnknownExecution = false;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await gateway.customTeamTemplateCreate({
          template: {
            templateId,
            name: nameValidation.value,
            schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
            teamPrompt: content.teamPrompt,
            members: content.members,
          },
          contentHash,
        });
      } catch (error) {
        if (error instanceof CustomTeamTemplateStorageInterruptedError) {
          const settlement = await waitForStorageSettlement(error.settled);
          if (error.execution === 'not_started') {
            if (settlement === 'settled') {
              continue;
            }
            if (hadUnknownExecution) {
              return { status: 'unresolvedWriteOutcome', templateId };
            }
            return { status: 'storageUnavailable' };
          }
          hadUnknownExecution = true;
          const check = await checkStoredTemplate(
            gateway,
            {
              templateId,
              name: nameValidation.value,
              contentHash,
            } as CustomTeamTemplateWriteIdentity,
            this.deps.hasher
          );
          if (check.status === 'saved') {
            const saved: CustomTeamTemplateV1 = {
              ...check.template,
              revision: check.template.revision ?? 1,
            };
            return { status: 'copied', template: saved };
          }
          if (check.status === 'absent') {
            if (attempt + 1 < MAX_CREATE_ATTEMPTS) {
              continue;
            }
          }
          return { status: 'unresolvedWriteOutcome', templateId };
        }
        if (hadUnknownExecution) {
          return { status: 'unresolvedWriteOutcome', templateId };
        }
        return { status: 'storageUnavailable' };
      }
      switch (result.status) {
        case 'created': {
          const created: CustomTeamTemplateV1 = {
            ...result.template,
            revision: result.template.revision ?? 1,
          };
          return { status: 'copied', template: created };
        }
        case 'alreadySaved': {
          const saved: CustomTeamTemplateV1 = {
            ...result.template,
            revision: result.template.revision ?? 1,
          };
          return { status: 'copied', template: saved };
        }
        case 'conflict':
          if (result.reason === 'nameTaken') {
            return { status: 'nameConflict', existingTemplateId: result.existingTemplateId };
          }
          if (attempt + 1 < MAX_CREATE_ATTEMPTS) {
            break;
          }
          return { status: 'templateIdConflict', templateId: result.existingTemplateId };
        case 'existingRecordUnreadable':
          return { status: 'unresolvedWriteOutcome', templateId };
        case 'retryable':
          if (attempt + 1 < MAX_CREATE_ATTEMPTS) {
            break;
          }
          if (hadUnknownExecution) {
            return { status: 'unresolvedWriteOutcome', templateId };
          }
          return { status: 'storageUnavailable' };
      }
    }
    if (hadUnknownExecution) {
      return { status: 'unresolvedWriteOutcome', templateId };
    }
    return { status: 'storageUnavailable' };
  }
}

function validationFailed(
  issues: readonly import('@features/custom-team-templates/contracts').CustomTeamTemplateValidationIssue[]
): CopyBuiltinTemplateResult {
  return { status: 'validationFailed', issues };
}

export type { CopyBuiltinTemplateRequest };
