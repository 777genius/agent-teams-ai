import type {
  CustomTeamTemplateContentV1,
  CustomTeamTemplateMemberV1,
} from '@features/custom-team-templates/contracts';

function canonicalizeMember(member: CustomTeamTemplateMemberV1): CustomTeamTemplateMemberV1 {
  return {
    name: member.name,
    ...(member.role !== undefined ? { role: member.role } : {}),
    ...(member.workflow !== undefined ? { workflow: member.workflow } : {}),
  };
}

/**
 * Deterministic canonical serialization of allowlisted template content.
 *
 * The output is rebuilt field by field in a fixed key order, so it is stable for
 * equivalent input regardless of how the source object was constructed.
 * Member order is preserved and therefore participates in content equality:
 * reordering the roster produces different canonical content.
 *
 * Identity, description and timestamps are intentionally excluded: they are not
 * part of content equivalence. No secrets or excluded source configuration are
 * present in the input.
 */
export function serializeCanonicalTemplateContent(content: CustomTeamTemplateContentV1): string {
  return JSON.stringify({
    schemaVersion: content.schemaVersion,
    teamPrompt: content.teamPrompt,
    members: content.members.map(canonicalizeMember),
  });
}
