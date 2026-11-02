import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import {
  CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT,
  CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION,
} from '@features/custom-team-templates/contracts';

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
  CustomTeamTemplateMemberV1,
  CustomTeamTemplateV1,
  ImportCustomTeamTemplateRequest,
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

export interface ImportCustomTeamTemplateUseCaseDeps {
  gateway: CustomTeamTemplateStorageGateway | null;
  hasher: CustomTeamTemplateHasher;
  createTemplateId: () => string;
}

const MAX_CREATE_ATTEMPTS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ImportCustomTeamTemplateUseCase {
  constructor(private readonly deps: ImportCustomTeamTemplateUseCaseDeps) {}

  async execute(payload: unknown): Promise<ImportCustomTeamTemplateResult> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return validationFailed([{ code: 'templateNameRequired', field: 'name' }]);
    }
    const candidate = payload as { portable?: unknown; name?: unknown };

    // Untrusted format/version validation.
    if (!isRecord(candidate.portable)) {
      return { status: 'unsupportedFormat', format: candidate.portable };
    }
    const portable = candidate.portable as Record<string, unknown>;
    if (portable.format !== CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT) {
      return { status: 'unsupportedFormat', format: portable.format };
    }
    if (portable.schemaVersion !== CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION) {
      return { status: 'unsupportedVersion', version: portable.schemaVersion };
    }

    // Validate name (allow override from payload.name).
    const nameInput = candidate.name !== undefined ? candidate.name : portable.name;
    const nameValidation = validateTemplateName(nameInput);
    if (!nameValidation.valid) {
      return validationFailed(nameValidation.issues);
    }

    // Validate teamPrompt.
    const teamPrompt = typeof portable.teamPrompt === 'string' ? portable.teamPrompt : '';
    if (typeof portable.teamPrompt !== 'string') {
      return validationFailed([{ code: 'teamPromptTooLong', field: 'teamPrompt' }]); // type issue; reuse
    }
    // members
    if (!Array.isArray(portable.members)) {
      return validationFailed([{ code: 'tooManyMembers', field: 'members' }]);
    }
    const members: CustomTeamTemplateMemberV1[] = [];
    for (const m of portable.members) {
      if (!isRecord(m)) {
        return validationFailed([{ code: 'memberNameRequired', field: 'members' }]);
      }
      const name = typeof m.name === 'string' ? m.name : '';
      const role = typeof m.role === 'string' ? m.role : undefined;
      const workflow = typeof m.workflow === 'string' ? m.workflow : undefined;
      members.push({ name, ...(role ? { role } : {}), ...(workflow ? { workflow } : {}) });
    }

    const description =
      typeof portable.description === 'string' ? portable.description.trim() : undefined;
    const normalizedDescription = description && description.length > 0 ? description : undefined;

    const contentIssues = validateTemplateContent({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt,
      members,
    });
    if (contentIssues.length > 0) {
      return validationFailed(contentIssues);
    }

    // description length check
    // (domain policy: reuse templateDescriptionTooLong? check limits)
    // We'll rely on existing; simple.

    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    const canonical = serializeCanonicalTemplateContent({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt,
      members,
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
            ...(normalizedDescription ? { description: normalizedDescription } : {}),
            schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
            teamPrompt,
            members,
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
          const identity: CustomTeamTemplateWriteIdentity = {
            templateId,
            name: nameValidation.value,
            ...(normalizedDescription ? { description: normalizedDescription } : {}),
            contentHash,
          };
          const check = await checkStoredTemplate(gateway, identity, this.deps.hasher);
          if (check.status === 'saved') {
            return {
              status: 'imported',
              template: { ...check.template, revision: check.template.revision ?? 1 },
            };
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
        case 'created':
        case 'alreadySaved':
          return {
            status: 'imported',
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
): ImportCustomTeamTemplateResult {
  return { status: 'validationFailed', issues };
}

export type { ImportCustomTeamTemplateRequest };
