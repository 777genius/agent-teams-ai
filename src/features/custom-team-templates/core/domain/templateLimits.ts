/**
 * Validation bounds for custom team templates.
 *
 * Established repo limits reused here:
 * - template name: 128 characters, matching the teammate/team identifier bound
 *   enforced by `validateTeamMemberNameFormat` and `TeamIdentifierValidation`.
 * - teammate count: 100, matching `parseCreateMembers` and the team management
 *   roster policy.
 * - prompt and workflow text: 200_000 characters, matching the team management
 *   request `string()` bound.
 *
 * Description and role have no template-specific source limit yet. The values
 * below are explicit Phase 1 decisions; they stay well inside the 256 KiB team
 * metadata read ceiling and can be revised without changing the contracts.
 */
export const TEMPLATE_NAME_MAX_LENGTH = 128;
export const TEMPLATE_DESCRIPTION_MAX_LENGTH = 2_000;
export const TEMPLATE_TEAM_PROMPT_MAX_LENGTH = 200_000;
export const TEMPLATE_MAX_MEMBERS = 100;
export const TEMPLATE_MEMBER_ROLE_MAX_LENGTH = 128;
export const TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH = 200_000;
