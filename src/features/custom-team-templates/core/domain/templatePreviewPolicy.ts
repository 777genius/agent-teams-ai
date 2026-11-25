import { serializeCanonicalTemplateContent } from './canonicalTemplateSerialization';
import { projectTemplateContent, validateTemplateContent } from './templateContentPolicy';
import { TEMPLATE_DESCRIPTION_MAX_LENGTH } from './templateLimits';
import { validateTemplateName } from './templateNamePolicy';

import type { CustomTemplateSourceTeamSnapshot } from './templateSourceSnapshot';
import type {
  CustomTeamTemplatePreviewContent,
  CustomTeamTemplateValidationIssue,
} from '@features/custom-team-templates/contracts';

export function validateTemplateDescription(
  description: string | undefined
): readonly CustomTeamTemplateValidationIssue[] {
  if (description !== undefined && description.length > TEMPLATE_DESCRIPTION_MAX_LENGTH) {
    return [{ code: 'templateDescriptionTooLong', field: 'description' }];
  }
  return [];
}

export type BuildTemplatePreviewContentResult =
  | { status: 'ready'; preview: CustomTeamTemplatePreviewContent }
  | { status: 'rosterUnreadable'; sourceTeamName: string }
  | { status: 'validationFailed'; issues: readonly CustomTeamTemplateValidationIssue[] };

/**
 * Builds the pure preview for one source team.
 *
 * Local name/description validation runs first so the user can fix obvious input
 * even when the source roster is unreadable. The resulting `canonicalContent` is
 * exactly what a later confirm-save persists, which is what guarantees the
 * confirmed preview and the stored record agree.
 */
export function buildTemplatePreviewContent(input: {
  snapshot: CustomTemplateSourceTeamSnapshot;
  name: string;
  description?: string;
}): BuildTemplatePreviewContentResult {
  const nameValidation = validateTemplateName(input.name);
  const descriptionIssues = validateTemplateDescription(input.description);
  if (!nameValidation.valid || descriptionIssues.length > 0) {
    return {
      status: 'validationFailed',
      issues: [...(nameValidation.valid ? [] : nameValidation.issues), ...descriptionIssues],
    };
  }

  const projection = projectTemplateContent(input.snapshot);
  if (projection.status === 'rosterUnreadable') {
    return projection;
  }

  const contentIssues = validateTemplateContent(projection.content);
  if (contentIssues.length > 0) {
    return { status: 'validationFailed', issues: contentIssues };
  }

  const description = input.description?.trim();
  return {
    status: 'ready',
    preview: {
      sourceTeamName: input.snapshot.sourceTeamName,
      name: nameValidation.value,
      ...(description ? { description } : {}),
      teamPrompt: projection.content.teamPrompt,
      members: projection.content.members,
      warnings: projection.warnings,
      canonicalContent: serializeCanonicalTemplateContent(projection.content),
    },
  };
}
