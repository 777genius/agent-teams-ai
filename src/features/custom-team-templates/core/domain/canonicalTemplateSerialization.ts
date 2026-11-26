import type {
  CustomTeamTemplateContentV1,
  CustomTeamTemplateMemberV1,
} from '@features/custom-team-templates/contracts';

/**
 * Normalizes one allowlisted member to its canonical shape.
 *
 * An optional `role`/`workflow` is kept only when it carries a value, so
 * `undefined` and the empty string are both treated as "absent". Persistence
 * drops the same falsy optionals before writing, and hashing must apply the
 * exact same rule: otherwise a stored row would no longer hash to the digest
 * its write recorded, and reconciliation could not recognise its own commit.
 *
 * This is the single rule shared by canonical serialization, the update use
 * case payload and the storage mapper.
 */
export function normalizeTemplateMember(
  member: CustomTeamTemplateMemberV1
): CustomTeamTemplateMemberV1 {
  return {
    name: member.name,
    ...(member.role ? { role: member.role } : {}),
    ...(member.workflow ? { workflow: member.workflow } : {}),
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
    members: content.members.map(normalizeTemplateMember),
  });
}
