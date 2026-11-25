import { normalizeTemplateMember } from '@features/custom-team-templates';
import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';

import type { customTeamTemplates } from './internalStorageSchema';
import type {
  CreateCustomTeamTemplateRecordRequest,
  CustomTeamTemplateMemberV1,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

/** Persisted row shape for one saved custom team template. */
export type StoredCustomTeamTemplateRow = typeof customTeamTemplates.$inferSelect;

export type StoredCustomTeamTemplateRead =
  | { status: 'readable'; template: CustomTeamTemplateV1 }
  | { status: 'unreadable'; templateId: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses allowlisted member entries from an untrusted source.
 *
 * Used in both directions: to validate the create payload after the worker
 * hop, and to reconstruct a stored row. Each member is rebuilt field by field,
 * so unknown keys can never enter or leave the persisted representation.
 * Empty optional metadata is normalized away through the same shared rule the
 * canonical serializer uses, so the persisted row always hashes to the digest
 * its write recorded.
 * Returns null when any entry is structurally invalid, which is what makes a
 * stored row unreadable instead of silently trimmed.
 */
export function parseTemplateMembers(value: unknown): CustomTeamTemplateMemberV1[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const members: CustomTeamTemplateMemberV1[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) {
      return null;
    }
    const { name, role, workflow } = entry;
    if (typeof name !== 'string' || !name) {
      return null;
    }
    if (role !== undefined && typeof role !== 'string') {
      return null;
    }
    if (workflow !== undefined && typeof workflow !== 'string') {
      return null;
    }
    members.push(
      normalizeTemplateMember({
        name,
        ...(typeof role === 'string' ? { role } : {}),
        ...(typeof workflow === 'string' ? { workflow } : {}),
      })
    );
  }
  return members;
}

/**
 * Builds the exact row to insert.
 *
 * Column values come from validated input only: the normalized name is derived
 * by the caller from the shared domain rule, and the creation timestamp is
 * stamped here by the trusted storage clock rather than accepted from a caller.
 */
export function toStoredTemplateRow(input: {
  request: CreateCustomTeamTemplateRecordRequest;
  nameNormalized: string;
  createdAt: string;
}): StoredCustomTeamTemplateRow {
  const { template, contentHash } = input.request;
  return {
    id: template.templateId,
    name: template.name,
    nameNormalized: input.nameNormalized,
    description: template.description ?? null,
    schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
    teamPrompt: template.teamPrompt,
    membersJson: JSON.stringify(template.members),
    contentHash,
    createdAt: input.createdAt,
    revision: 1,
  };
}

/**
 * Reconstructs a stored template, or reports it as unreadable.
 *
 * A record written by an unknown contract version, or one whose members no
 * longer parse, is reported as unreadable: it is never reinterpreted as a valid
 * empty template and never silently dropped.
 */
export function readStoredTemplate(row: StoredCustomTeamTemplateRow): StoredCustomTeamTemplateRead {
  if (row.schemaVersion !== CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION) {
    return { status: 'unreadable', templateId: row.id };
  }
  let parsedMembers: unknown;
  try {
    parsedMembers = JSON.parse(row.membersJson);
  } catch {
    return { status: 'unreadable', templateId: row.id };
  }
  const members = parseTemplateMembers(parsedMembers);
  if (!members) {
    return { status: 'unreadable', templateId: row.id };
  }
  const revision =
    typeof row.revision === 'number' && Number.isInteger(row.revision) ? row.revision : 1;
  return {
    status: 'readable',
    template: {
      templateId: row.id,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: row.teamPrompt,
      members,
      createdAt: row.createdAt,
      revision,
    },
  };
}

/**
 * Decides whether an existing row already represents the requested save.
 *
 * Equivalence covers the normalized uniqueness key, the content digest and the
 * description only. Display capitalization is presentation, not immutable
 * content, so a retry with different capitalization stays idempotent and keeps
 * the capitalization that was stored first.
 */
export function isStoredTemplateEquivalentToRequest(
  row: StoredCustomTeamTemplateRow,
  requested: { nameNormalized: string; contentHash: string; description: string | null }
): boolean {
  return (
    row.nameNormalized === requested.nameNormalized &&
    row.contentHash === requested.contentHash &&
    (row.description ?? null) === requested.description
  );
}
