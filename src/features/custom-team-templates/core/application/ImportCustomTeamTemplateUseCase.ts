import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import {
  CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT,
  CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION,
} from '@features/custom-team-templates/contracts';

import { serializeCanonicalTemplateContent } from '../domain/canonicalTemplateSerialization';
import { validateTemplateContent } from '../domain/templateContentPolicy';
import {
  TEMPLATE_MAX_MEMBERS,
  TEMPLATE_MEMBER_ROLE_MAX_LENGTH,
  TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH,
  TEMPLATE_TEAM_PROMPT_MAX_LENGTH,
} from '../domain/templateLimits';
import { validateTemplateName } from '../domain/templateNamePolicy';
import { validateTemplateDescription } from '../domain/templatePreviewPolicy';

import { CustomTeamTemplateStorageInterruptedError } from './CustomTeamTemplateStorageInterruptedError';
import {
  checkStoredTemplate,
  type CustomTeamTemplateWriteIdentity,
} from './reconcileCustomTeamTemplateWrite';
import { waitForStorageSettlement } from './waitForStorageSettlement';

import type { CustomTeamTemplateHasher, CustomTeamTemplateStorageGateway } from './ports';
import type {
  CustomTeamTemplateMemberV1,
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

export interface ImportCustomTeamTemplateUseCaseDeps {
  gateway: CustomTeamTemplateStorageGateway | null;
  hasher: CustomTeamTemplateHasher;
  createTemplateId: () => string;
}

const MAX_CREATE_ATTEMPTS = 2;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'format',
  'schemaVersion',
  'name',
  'description',
  'teamPrompt',
  'members',
]);
const ALLOWED_MEMBER_KEYS = new Set(['name', 'role', 'workflow']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  // Reject dangerous keys by constructing from null prototype.
  return true;
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return false;
    }
    // Guard against prototype-pollution keys even if somehow present.
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return false;
    }
  }
  return true;
}

function validationFailed(
  issues: readonly import('@features/custom-team-templates/contracts').CustomTeamTemplateValidationIssue[]
): ImportCustomTeamTemplateResult {
  return { status: 'validationFailed', issues };
}

export class ImportCustomTeamTemplateUseCase {
  constructor(private readonly deps: ImportCustomTeamTemplateUseCaseDeps) {}

  async execute(payload: unknown): Promise<ImportCustomTeamTemplateResult> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { status: 'unsupportedFormat', format: payload };
    }
    const candidate = payload as { portable?: unknown; name?: unknown };
    const portableInput = candidate.portable !== undefined ? candidate.portable : payload;

    if (!isPlainRecord(portableInput)) {
      return { status: 'unsupportedFormat', format: portableInput };
    }
    const portable = portableInput as Record<string, unknown>;

    if (!hasOnlyKeys(portable, ALLOWED_TOP_LEVEL_KEYS)) {
      return validationFailed([{ code: 'templateNameRequired', field: 'name' }]); // unexpected property
    }

    if (portable.format !== CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT) {
      return { status: 'unsupportedFormat', format: portable.format };
    }
    if (portable.schemaVersion !== CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION) {
      return { status: 'unsupportedVersion', version: portable.schemaVersion };
    }

    // name (allow override)
    const nameInput = candidate.name !== undefined ? candidate.name : portable.name;
    const nameValidation = validateTemplateName(nameInput);
    if (!nameValidation.valid) {
      return validationFailed(nameValidation.issues);
    }

    // teamPrompt must be a string. The existing contract has no dedicated
    // invalid-type code, and the length code is the closest established
    // outcome for "this field cannot be accepted".
    if (typeof portable.teamPrompt !== 'string') {
      return validationFailed([{ code: 'teamPromptTooLong', field: 'teamPrompt' }]);
    }
    const teamPrompt = portable.teamPrompt;

    // description
    let description: string | undefined;
    if (portable.description !== undefined) {
      if (typeof portable.description !== 'string') {
        return validationFailed([{ code: 'templateDescriptionTooLong', field: 'description' }]);
      }
      const descIssues = validateTemplateDescription(portable.description);
      if (descIssues.length > 0) {
        return validationFailed(descIssues);
      }
      const trimmed = (portable.description as string).trim();
      description = trimmed.length > 0 ? trimmed : undefined;
    }

    // members
    if (!Array.isArray(portable.members)) {
      return validationFailed([{ code: 'tooManyMembers', field: 'members' }]);
    }
    if (portable.members.length > TEMPLATE_MAX_MEMBERS) {
      return validationFailed([{ code: 'tooManyMembers', field: 'members' }]);
    }

    const members: CustomTeamTemplateMemberV1[] = [];
    for (let i = 0; i < portable.members.length; i += 1) {
      const m = portable.members[i];
      if (!isPlainRecord(m)) {
        return validationFailed([{ code: 'memberNameRequired', field: `members[${i}].name` }]);
      }
      const member = m as Record<string, unknown>;
      if (!hasOnlyKeys(member, ALLOWED_MEMBER_KEYS)) {
        return validationFailed([{ code: 'memberNameRequired', field: `members[${i}].name` }]);
      }
      if (typeof member.name !== 'string') {
        return validationFailed([{ code: 'memberNameRequired', field: `members[${i}].name` }]);
      }
      const name = member.name.trim();
      if (!name) {
        return validationFailed([{ code: 'memberNameRequired', field: `members[${i}].name` }]);
      }
      let role: string | undefined;
      if (member.role !== undefined) {
        if (typeof member.role !== 'string') {
          return validationFailed([{ code: 'memberRoleTooLong', field: `members[${i}].role` }]);
        }
        const r = (member.role as string).trim();
        if (r.length > TEMPLATE_MEMBER_ROLE_MAX_LENGTH) {
          return validationFailed([{ code: 'memberRoleTooLong', field: `members[${i}].role` }]);
        }
        role = r.length > 0 ? r : undefined;
      }
      let workflow: string | undefined;
      if (member.workflow !== undefined) {
        if (typeof member.workflow !== 'string') {
          return validationFailed([
            { code: 'memberWorkflowTooLong', field: `members[${i}].workflow` },
          ]);
        }
        const w = (member.workflow as string).trim();
        // Multiline instructions keep their internal newlines; only the edges
        // are trimmed to match the established projection convention.
        if ((member.workflow as string).length > TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH) {
          return validationFailed([
            { code: 'memberWorkflowTooLong', field: `members[${i}].workflow` },
          ]);
        }
        workflow = w.length > 0 ? (member.workflow as string) : undefined;
      }
      members.push({
        name,
        ...(role ? { role } : {}),
        ...(workflow ? { workflow } : {}),
      });
    }

    // teamPrompt length check
    if (teamPrompt.length > TEMPLATE_TEAM_PROMPT_MAX_LENGTH) {
      return validationFailed([{ code: 'teamPromptTooLong', field: 'teamPrompt' }]);
    }

    const contentIssues = validateTemplateContent({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt,
      members,
    });
    if (contentIssues.length > 0) {
      return validationFailed(contentIssues);
    }

    const descIssues = validateTemplateDescription(description);
    if (descIssues.length > 0) {
      return validationFailed(descIssues);
    }

    // Fresh sanitized projection of exactly the validated fields. It is built
    // field by field so no untrusted object member can reach a result or a
    // stored record, and it lets a name-conflict retry reuse the reviewed
    // content without touching the file again.
    const portableTemplate: PortableCustomTeamTemplateV1 = {
      format: CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT,
      schemaVersion: CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION,
      name: nameValidation.value,
      ...(description ? { description } : {}),
      teamPrompt,
      members,
    };

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
            ...(description ? { description } : {}),
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
            ...(description ? { description } : {}),
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
            return {
              status: 'nameConflict',
              existingTemplateId: result.existingTemplateId,
              portable: portableTemplate,
            };
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
