import type { CustomTeamTemplateMemberV1, CustomTeamTemplateV1 } from './template';
import type { CustomTeamTemplateWarning } from './warnings';

/**
 * Deterministic validation codes suitable for later UI localization.
 * Codes never encode prose and never silently truncate input.
 */
export type CustomTeamTemplateValidationIssueCode =
  | 'templateNameRequired'
  | 'templateNameTooLong'
  | 'templateNameInvalidCharacters'
  | 'templateDescriptionTooLong'
  | 'teamPromptTooLong'
  | 'tooManyMembers'
  | 'memberNameRequired'
  | 'memberNameInvalid'
  | 'duplicateMemberName'
  | 'memberRoleTooLong'
  | 'memberWorkflowTooLong'
  /** The requested source team identity is missing or not a valid team identity. */
  | 'sourceTeamNameInvalid'
  /** Confirm-save arrived without a usable preview token. */
  | 'previewTokenRequired'
  /** The preview token does not belong to any live preview (never issued, or already replaced). */
  | 'previewTokenUnknown'
  /** The preview token existed but passed its lifetime, so the confirmed projection is gone. */
  | 'previewTokenExpired';

export interface CustomTeamTemplateValidationIssue {
  code: CustomTeamTemplateValidationIssueCode;
  /** Stable field path, e.g. `name`, `description`, `teamPrompt`, `members[0].role`. */
  field: string;
}

/**
 * Exact content a prepare-preview step produced for a source team.
 *
 * `canonicalContent` is the deterministic serialization of exactly the content
 * that a confirm-save will persist, so the confirmed preview and the saved
 * record cannot drift.
 */
export interface CustomTeamTemplatePreviewContent {
  sourceTeamName: string;
  name: string;
  description?: string;
  teamPrompt: string;
  members: readonly CustomTeamTemplateMemberV1[];
  warnings: readonly CustomTeamTemplateWarning[];
  canonicalContent: string;
}

export interface CustomTeamTemplatePreview extends CustomTeamTemplatePreviewContent {
  /**
   * Opaque token issued by the preview step and echoed by confirm-save.
   * Generation, hashing and storage belong to later phases.
   */
  previewToken: string;
}

export interface PrepareCustomTeamTemplatePreviewRequest {
  /** Existing team whose saved configuration supplies the allowlisted content. */
  sourceTeamName: string;
  name: string;
  description?: string;
}

/**
 * Prepare-preview outcomes.
 *
 * `sourceUnavailable` (no readable team configuration) is distinct from
 * `rosterUnreadable` (configuration exists but member metadata cannot be read)
 * and from `storageUnavailable` (the template store itself is unreachable).
 */
export type PrepareCustomTeamTemplatePreviewResult =
  | { status: 'previewReady'; preview: CustomTeamTemplatePreview }
  | { status: 'sourceUnavailable'; sourceTeamName: string }
  | { status: 'rosterUnreadable'; sourceTeamName: string }
  | { status: 'validationFailed'; issues: readonly CustomTeamTemplateValidationIssue[] }
  | { status: 'nameConflict'; existingTemplateId: string }
  | { status: 'storageUnavailable' };

export interface ConfirmCustomTeamTemplateSaveRequest {
  previewToken: string;
  /**
   * Optional display-name override applied when the user confirms.
   *
   * The reviewed preview already carries a name, so this field exists only so a
   * future UI can let the user edit the name before saving. It is validated by
   * the trusted layer exactly like the prepare-time name, and it can never
   * alter the reviewed team content or rebind the preview to another team.
   *
   * Omitting it (or passing `undefined`) keeps the name the preview reviewed.
   */
  name?: string;
  /**
   * Optional description override applied when the user confirms.
   *
   * An empty or whitespace-only string clears the description; omitting the
   * field keeps the description the preview reviewed.
   */
  description?: string;
}

/**
 * A missing, unknown or expired preview token is reported through the closed
 * validation-code union rather than a dedicated status: the token is an input
 * field of the confirm request, not a workflow outcome.
 */

/**
 * Confirm-save outcomes.
 *
 * `created`/`alreadySaved` express idempotent creation; `stalePreview` means the
 * source configuration no longer matches what the user confirmed;
 * `templateIdConflict` means a different stored record already owns the
 * identity derived from the confirmed content; `unresolvedWriteOutcome` means
 * the write result is unknown and must be reconciled before retrying.
 *
 * `storageUnavailable` is the opposite guarantee to `unresolvedWriteOutcome`:
 * the store did not accept the write and no record exists for the template id
 * (unreachable worker, exhausted lock contention, or a failed write that a
 * reconciliation read confirmed absent). It never means "the write may have
 * happened", and it is never reported as success.
 */
export type ConfirmCustomTeamTemplateSaveResult =
  | { status: 'created'; template: CustomTeamTemplateV1 }
  | { status: 'alreadySaved'; template: CustomTeamTemplateV1 }
  | { status: 'stalePreview'; sourceTeamName: string }
  | { status: 'sourceUnavailable'; sourceTeamName: string }
  | { status: 'rosterUnreadable'; sourceTeamName: string }
  | { status: 'nameConflict'; existingTemplateId: string }
  | { status: 'templateIdConflict'; templateId: string }
  | { status: 'validationFailed'; issues: readonly CustomTeamTemplateValidationIssue[] }
  | { status: 'storageUnavailable' }
  | { status: 'unresolvedWriteOutcome'; templateId: string };

/**
 * Re-check an earlier confirmed save whose outcome stayed unresolved.
 *
 * The request carries nothing but the opaque operation reference the preview
 * already issued: the stable template id, the immutable request content and the
 * digest all come from retained server-side state, so a caller can never assert
 * content or identity. No write is attempted, so re-checking is always safe.
 */
export interface RecheckCustomTeamTemplateSaveRequest {
  previewToken: string;
}

/**
 * Re-check outcomes.
 *
 * `saved` is a confirmed success (the stored record is equivalent to the
 * operation), `templateIdConflict` means a different record owns the stable id,
 * `notSaved` is confirmed absence (no record exists for that id, so retrying the
 * same operation is safe), and `unresolved` means the store still cannot be
 * read, so the outcome stays honestly unknown. A record that exists but cannot
 * be reconstructed is always `unresolved`, never `notSaved`.
 */
export type RecheckCustomTeamTemplateSaveResult =
  | { status: 'saved'; template: CustomTeamTemplateV1 }
  | { status: 'templateIdConflict'; templateId: string }
  | { status: 'notSaved'; templateId: string }
  | { status: 'unresolved'; templateId: string }
  | { status: 'validationFailed'; issues: readonly CustomTeamTemplateValidationIssue[] }
  | { status: 'storageUnavailable' };

/** Listing takes no parameters. */
export type ListCustomTeamTemplatesRequest = Record<string, never>;

export type CustomTeamTemplateUnreadableReason = 'unreadableRecord';

export interface CustomTeamTemplateUnreadableRecord {
  templateId: string;
  reason: CustomTeamTemplateUnreadableReason;
}

/**
 * List outcomes.
 *
 * `empty` is a valid empty library and must never be reported as
 * `storageUnavailable`. `hasUnreadableRecords` still returns every readable
 * template, so a partially unreadable library stays usable.
 */
export type ListCustomTeamTemplatesResult =
  | { status: 'empty' }
  | { status: 'ready'; templates: readonly CustomTeamTemplateV1[] }
  | {
      status: 'hasUnreadableRecords';
      templates: readonly CustomTeamTemplateV1[];
      unreadableRecords: readonly CustomTeamTemplateUnreadableRecord[];
    }
  | { status: 'storageUnavailable' };
