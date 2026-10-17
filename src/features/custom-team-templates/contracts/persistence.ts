import type { CustomTeamTemplateUnreadableRecord } from './operations';
import type { CustomTeamTemplateV1 } from './template';

/**
 * Browser-safe persistence contracts for the custom team template library.
 *
 * These describe the exact conversation between the trusted main-process
 * application layer and the internal-storage worker. They are deliberately
 * narrower than the use-case contracts in `operations.ts`: no preview token,
 * no preview fingerprint and no localized presentation state crosses this
 * boundary.
 *
 * The library is app-global, not team-scoped, so none of these requests carry
 * a team name.
 */

/**
 * Persists one already-validated template.
 *
 * `createdAt` is intentionally absent: the trusted storage path stamps the
 * creation timestamp with its own clock, so a caller cannot backdate or
 * fabricate it. Display name, description and identity come from trusted main
 * code as well; the renderer never supplies this request directly.
 */
export interface CreateCustomTeamTemplateRecordRequest {
  template: Omit<CustomTeamTemplateV1, 'createdAt'>;
  /**
   * Opaque digest of the canonical content, produced by trusted main-process
   * code over `serializeCanonicalTemplateContent` output.
   *
   * The worker only stores this value and later compares it with the value it
   * previously stored for the same template id; it never re-derives the digest
   * and never treats a caller-supplied digest as proof of content. Digest
   * algorithms stay swappable because only equality matters here.
   */
  contentHash: string;
}

/**
 * Why an existing stored template blocked the requested creation.
 *
 * - `idReusedWithDifferentContent`: the same template id is already stored with
 *   different immutable content. The stored record is never overwritten.
 * - `nameTaken`: the normalized display name already belongs to another
 *   template id.
 */
export type CustomTeamTemplateCreateConflictReason = 'idReusedWithDifferentContent' | 'nameTaken';

/**
 * Creation outcomes.
 *
 * `alreadySaved` is the idempotent retry outcome for the same id and identical
 * immutable content. `existingRecordUnreadable` means a stored record exists
 * under the requested id but cannot be reconstructed, so the write outcome
 * cannot be confirmed either way. `retryable` means the database was busy and
 * the caller may retry the same request with the same template id.
 */
export type CreateCustomTeamTemplateRecordResult =
  | { status: 'created'; template: CustomTeamTemplateV1 }
  | { status: 'alreadySaved'; template: CustomTeamTemplateV1 }
  | {
      status: 'conflict';
      reason: CustomTeamTemplateCreateConflictReason;
      existingTemplateId: string;
    }
  | { status: 'existingRecordUnreadable'; templateId: string }
  | { status: 'retryable'; reason: 'databaseBusy' };

/**
 * Library read outcome.
 *
 * A stored record whose content can no longer be reconstructed is reported as
 * unreadable instead of being dropped or reported as a valid empty template, so
 * a partially damaged library stays usable and observable.
 */
export interface ListCustomTeamTemplateRecordsResult {
  templates: readonly CustomTeamTemplateV1[];
  unreadableRecords: readonly CustomTeamTemplateUnreadableRecord[];
}

export interface ReadCustomTeamTemplateRecordRequest {
  templateId: string;
}

/** Single-record read outcome, used to reconcile an uncertain create. */
export type ReadCustomTeamTemplateRecordResult =
  | { status: 'found'; template: CustomTeamTemplateV1 }
  | { status: 'notFound' }
  | { status: 'unreadable'; templateId: string };

/**
 * Persistence port for the custom team template library.
 *
 * The custom-team-templates feature owns this port; internal-storage supplies
 * the concrete SQLite worker implementation. Every method is one worker
 * round-trip, and every mutating call is a single worker-side transaction, so
 * uniqueness and idempotency cannot be split by a caller-side read-then-write.
 *
 * There is deliberately no JSON fallback implementation: A1 has no legacy
 * template store to degrade to, so an unavailable worker must surface as
 * unavailable storage instead of a silently empty library.
 */
export interface CustomTeamTemplateStorageGateway {
  /** Idempotent by template id: retrying the same request never duplicates a row. */
  customTeamTemplateCreate(
    request: CreateCustomTeamTemplateRecordRequest
  ): Promise<CreateCustomTeamTemplateRecordResult>;
  /** Returns every readable template plus any records that cannot be read back. */
  customTeamTemplateList(): Promise<ListCustomTeamTemplateRecordsResult>;
  /** Reconciles an uncertain create by stable template id. */
  customTeamTemplateGetById(
    request: ReadCustomTeamTemplateRecordRequest
  ): Promise<ReadCustomTeamTemplateRecordResult>;
}
