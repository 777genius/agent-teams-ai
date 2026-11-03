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
  CustomTeamTemplateValidationIssue,
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

export interface ImportCustomTeamTemplateUseCaseDeps {
  gateway: CustomTeamTemplateStorageGateway | null;
  hasher: CustomTeamTemplateHasher;
  createTemplateId: () => string;
}

const MAX_CREATE_ATTEMPTS = 2;
/**
 * Upper bound for the property name echoed back in a validation issue, so a
 * hostile file cannot inflate the localized message with a huge key.
 */
const MAX_REPORTED_PROPERTY_LENGTH = 80;

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'format',
  'schemaVersion',
  'name',
  'description',
  'teamPrompt',
  'members',
]);
const ALLOWED_MEMBER_KEYS = new Set(['name', 'role', 'workflow']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Narrows an untrusted value to a non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the first own key outside `allowed`, or null when the object only has
 * allowlisted keys.
 *
 * Prototype-pollution keys are reported as unexpected even when a future
 * allowlist accidentally contains them, so this stays a separate allowlist
 * check rather than being folded into `isPlainRecord`.
 */
function findUnexpectedKey(obj: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) {
      return key;
    }
  }
  return null;
}

/** Bounds the reported key so an oversized key cannot bloat a UI message. */
function reportedKey(key: string): string {
  return key.length > MAX_REPORTED_PROPERTY_LENGTH
    ? `${key.slice(0, MAX_REPORTED_PROPERTY_LENGTH)}…`
    : key;
}

function unexpectedPropertyIssue(path: string, key: string): CustomTeamTemplateValidationIssue {
  return { code: 'unexpectedProperty', field: reportedKey(path), parameter: reportedKey(key) };
}

function validationFailed(
  issues: readonly CustomTeamTemplateValidationIssue[]
): ImportCustomTeamTemplateResult {
  return { status: 'validationFailed', issues };
}

/**
 * Imports one untrusted portable template under a brand-new local identity.
 *
 * The document is validated field by field against the portable allowlist before
 * anything is hashed or written, and the stored record always receives a fresh
 * id, a fresh revision and a canonical content hash derived here, so imported
 * files can never control storage identity.
 *
 * Write outcomes are closed and honest: `storageUnavailable` means nothing was
 * written, while `unresolvedWriteOutcome` means the write may already have
 * landed and must therefore never be retried automatically. The bounded
 * `MAX_CREATE_ATTEMPTS` retry only covers answers that prove nothing was stored.
 */
export class ImportCustomTeamTemplateUseCase {
  constructor(private readonly deps: ImportCustomTeamTemplateUseCaseDeps) {}

  /**
   * Validates, hashes and persists one portable payload.
   *
   * Resolves with a typed result for every outcome (including cancellation-free
   * validation failures and unknown write outcomes) instead of rejecting, except
   * for a rejected storage call, which is reported as `storageUnavailable` or
   * `unresolvedWriteOutcome` depending on whether a write was already in flight.
   */
  async execute(payload: unknown): Promise<ImportCustomTeamTemplateResult> {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { status: 'unsupportedFormat' };
    }
    const candidate = payload as { portable?: unknown; name?: unknown };
    const portableInput = candidate.portable !== undefined ? candidate.portable : payload;

    if (!isPlainRecord(portableInput)) {
      return { status: 'unsupportedFormat' };
    }
    const portable = portableInput;

    const unexpectedTopLevelKey = findUnexpectedKey(portable, ALLOWED_TOP_LEVEL_KEYS);
    if (unexpectedTopLevelKey !== null) {
      return validationFailed([
        unexpectedPropertyIssue(unexpectedTopLevelKey, unexpectedTopLevelKey),
      ]);
    }

    if (portable.format !== CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT) {
      return { status: 'unsupportedFormat' };
    }
    if (portable.schemaVersion !== CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION) {
      return { status: 'unsupportedVersion' };
    }

    // name (allow override)
    const nameInput = candidate.name !== undefined ? candidate.name : portable.name;
    const nameValidation = validateTemplateName(nameInput);
    if (!nameValidation.valid) {
      return validationFailed(nameValidation.issues);
    }

    // teamPrompt must be a string. A non-string teamPrompt is an invalid type,
    // not an excessive length, so it uses its own dedicated issue code.
    if (typeof portable.teamPrompt !== 'string') {
      return validationFailed([{ code: 'teamPromptInvalidType', field: 'teamPrompt' }]);
    }
    // Normalize with the established projection/update trim() policy before
    // validation, hashing and the write payload. Internal whitespace and
    // newlines are preserved; empty and whitespace-only prompts stay allowed.
    const teamPrompt = portable.teamPrompt.trim();

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
      const trimmed = portable.description.trim();
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
      const member = m;
      const unexpectedMemberKey = findUnexpectedKey(member, ALLOWED_MEMBER_KEYS);
      if (unexpectedMemberKey !== null) {
        return validationFailed([
          unexpectedPropertyIssue(`members[${i}].${unexpectedMemberKey}`, unexpectedMemberKey),
        ]);
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
        const r = member.role.trim();
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
        const w = member.workflow.trim();
        // Multiline instructions keep their internal newlines; only the edges
        // are trimmed to match the established projection convention.
        if (w.length > TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH) {
          return validationFailed([
            { code: 'memberWorkflowTooLong', field: `members[${i}].workflow` },
          ]);
        }
        workflow = w.length > 0 ? w : undefined;
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

    let templateId = this.deps.createTemplateId();
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
          // A generated id that is already stored with different content is a
          // definitive collision: retrying the same id would repeat it. Only a
          // confirmed answer may rotate identity; an uncertain prior execution
          // must never be retried under a different id.
          if (hadUnknownExecution) {
            return { status: 'unresolvedWriteOutcome', templateId };
          }
          if (attempt + 1 < MAX_CREATE_ATTEMPTS) {
            templateId = this.deps.createTemplateId();
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
