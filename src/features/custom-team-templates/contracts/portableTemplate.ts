import type { CustomTeamTemplateMemberV1 } from './template';

/**
 * Portable (file-format) representation of one custom team template.
 *
 * This is the only shape that crosses the import/export file boundary. It
 * deliberately excludes every local persistence field: no template id, no
 * revision, no creation timestamp, no content hash and no storage metadata.
 *
 * `format` and `schemaVersion` are the on-disk contract identifiers; both must
 * be validated on import before any field is trusted.
 */
export const CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT = 'agent-teams-custom-template' as const;
export const CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION = 1 as const;

export type CustomTeamTemplatePortableFormat = typeof CUSTOM_TEAM_TEMPLATE_PORTABLE_FORMAT;
export type CustomTeamTemplatePortableSchemaVersion =
  typeof CUSTOM_TEAM_TEMPLATE_PORTABLE_SCHEMA_VERSION;

export interface PortableCustomTeamTemplateV1 {
  format: CustomTeamTemplatePortableFormat;
  schemaVersion: CustomTeamTemplatePortableSchemaVersion;
  /** Display name carried by the portable template. */
  name: string;
  /** Optional description carried by the portable template. */
  description?: string;
  /** Team-level instructions. */
  teamPrompt: string;
  /** Ordered allowlisted members. */
  members: readonly CustomTeamTemplateMemberV1[];
}

/**
 * The on-disk envelope is exactly the portable template itself: format and
 * schemaVersion are required top-level fields, and the template data lives
 * alongside them (no nested `template` wrapper) so the file stays readable and
 * diffable.
 */
export type CustomTeamTemplatePortableFile = PortableCustomTeamTemplateV1;
