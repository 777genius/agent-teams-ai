/**
 * Typed preview warnings for custom team templates.
 *
 * Warnings are codes with only the data required for interpolation. Localized
 * prose is produced later by the presentation layer, never here.
 *
 * Informational warnings (`noRecordedRoster`, `emptyRoster`, `missingTeamPrompt`,
 * `missingMemberRole`, `missingMemberWorkflow`, `removedMembersExcluded`) never
 * block saving by themselves.
 */
export type CustomTeamTemplateWarning =
  | { code: 'missingTeamPrompt' }
  /** No roster metadata was recorded; a prompt-only template is still valid. */
  | { code: 'noRecordedRoster' }
  /** Roster metadata was read successfully and projected to zero members. */
  | { code: 'emptyRoster' }
  | { code: 'missingMemberRole'; memberName: string }
  | { code: 'missingMemberWorkflow'; memberName: string }
  /** Removed, non-lead roster entries were excluded from the projection. */
  | { code: 'removedMembersExcluded'; count: number };
