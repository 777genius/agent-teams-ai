import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { serializeCanonicalTemplateContent } from '../domain/canonicalTemplateSerialization';
import { validateTemplateContent } from '../domain/templateContentPolicy';
import { validateTemplateName } from '../domain/templateNamePolicy';
import { validateTemplateDescription } from '../domain/templatePreviewPolicy';

import type { CustomTeamTemplateHasher, CustomTeamTemplateStorageGateway } from './ports';
import type {
  CustomTeamTemplateMemberV1,
  CustomTeamTemplateValidationIssue,
  UpdateCustomTeamTemplateRequest,
  UpdateCustomTeamTemplateResult,
} from '@features/custom-team-templates/contracts';

export interface UpdateCustomTeamTemplateUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
  hasher: CustomTeamTemplateHasher;
}

interface ParsedUpdateRequest {
  templateId: string;
  expectedRevision: number;
  name: unknown;
  description: unknown;
  teamPrompt: unknown;
  members: unknown;
}

function parseUpdateRequest(payload: unknown): ParsedUpdateRequest | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as {
    templateId?: unknown;
    expectedRevision?: unknown;
    fields?: unknown;
  };
  if (typeof candidate.templateId !== 'string' || !candidate.templateId.trim()) {
    return null;
  }
  if (
    typeof candidate.expectedRevision !== 'number' ||
    !Number.isInteger(candidate.expectedRevision)
  ) {
    return null;
  }
  if (typeof candidate.fields !== 'object' || candidate.fields === null) {
    return null;
  }
  const fields = candidate.fields as {
    name?: unknown;
    description?: unknown;
    teamPrompt?: unknown;
    members?: unknown;
  };
  return {
    templateId: candidate.templateId,
    expectedRevision: candidate.expectedRevision,
    name: fields.name,
    description: fields.description,
    teamPrompt: fields.teamPrompt,
    members: fields.members,
  };
}

function toAllowlistedMembers(value: unknown): CustomTeamTemplateMemberV1[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const members: CustomTeamTemplateMemberV1[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    const candidate = entry as { name?: unknown; role?: unknown; workflow?: unknown };
    if (typeof candidate.name !== 'string') {
      return null;
    }
    if (candidate.role !== undefined && typeof candidate.role !== 'string') {
      return null;
    }
    if (candidate.workflow !== undefined && typeof candidate.workflow !== 'string') {
      return null;
    }
    members.push({
      name: candidate.name,
      ...(candidate.role === undefined ? {} : { role: candidate.role }),
      ...(candidate.workflow === undefined ? {} : { workflow: candidate.workflow }),
    });
  }
  return members;
}

/**
 * Edits one custom template's allowlisted fields (A3).
 *
 * Only name, description, team prompt and member name/role/workflow are
 * accepted; everything else an envelope carries is ignored. Validation reuses
 * the A1 field allowlist and bounds. The write is a single worker-side
 * compare-and-swap against `expectedRevision`: a stale editor receives the
 * current stored state (`revisionConflict`) instead of overwriting a newer
 * edit. Editing changes future creations only — teams already created from
 * the template live outside this table and are untouched.
 */
export class UpdateCustomTeamTemplateUseCase {
  constructor(private readonly deps: UpdateCustomTeamTemplateUseCaseDeps) {}

  async execute(payload: unknown): Promise<UpdateCustomTeamTemplateResult> {
    const request = parseUpdateRequest(payload);
    if (!request) {
      return validationFailed([{ code: 'templateNameRequired', field: 'name' }]);
    }

    const nameValidation = validateTemplateName(request.name);
    const description =
      request.description === undefined
        ? undefined
        : typeof request.description === 'string'
          ? request.description
          : undefined;
    const descriptionIssues = validateTemplateDescription(description);
    const teamPrompt = typeof request.teamPrompt === 'string' ? request.teamPrompt : null;
    const members = toAllowlistedMembers(request.members);

    if (!nameValidation.valid || descriptionIssues.length > 0) {
      return validationFailed([
        ...(nameValidation.valid ? [] : nameValidation.issues),
        ...descriptionIssues,
      ]);
    }
    if (teamPrompt === null || members === null) {
      return validationFailed([{ code: 'memberNameRequired', field: 'members' }]);
    }

    const trimmedDescription = description?.trim();
    const contentValidation = validateTemplateContent({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt,
      members,
    });
    if (contentValidation.length > 0) {
      return validationFailed(contentValidation);
    }

    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    const contentHash = this.deps.hasher.hashCanonicalContent(
      serializeCanonicalTemplateContent({
        schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
        teamPrompt,
        members,
      })
    );

    let result;
    try {
      result = await gateway.customTeamTemplateUpdate({
        templateId: request.templateId,
        expectedRevision: request.expectedRevision,
        template: {
          templateId: request.templateId,
          name: nameValidation.value,
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
          schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
          teamPrompt,
          members,
        },
        contentHash,
      });
    } catch {
      return { status: 'storageUnavailable' };
    }

    switch (result.status) {
      case 'updated':
        return { status: 'updated', template: result.template };
      case 'revisionConflict':
        return { status: 'revisionConflict', current: result.current };
      case 'notFound':
        return { status: 'notFound', templateId: result.templateId };
      case 'unreadable':
        return { status: 'unreadableRecord', templateId: result.templateId };
      case 'conflict':
        return { status: 'nameConflict', existingTemplateId: result.existingTemplateId };
      case 'retryable':
        return { status: 'storageUnavailable' };
    }
  }
}

function validationFailed(
  issues: readonly CustomTeamTemplateValidationIssue[]
): UpdateCustomTeamTemplateResult {
  return { status: 'validationFailed', issues };
}

export type { UpdateCustomTeamTemplateRequest };
