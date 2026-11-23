import type { CustomTemplateSourceTeamSnapshot } from '../domain/templateSourceSnapshot';

export type { CustomTeamTemplateStorageGateway } from '../../contracts';

/**
 * Outcome of reading one source team's authoritative saved configuration.
 *
 * `configurationChanged` is reported when the authoritative files changed while
 * the snapshot was being read. It is deliberately distinct from
 * `sourceUnavailable`: nothing was fabricated, the read simply cannot be
 * attributed to a single consistent state.
 */
export type CustomTeamTemplateSnapshotReadOutcome =
  | { status: 'available'; snapshot: CustomTemplateSourceTeamSnapshot; revision: string }
  | { status: 'sourceUnavailable'; sourceTeamName: string }
  | { status: 'configurationChanged'; sourceTeamName: string };

/**
 * Reads the saved configuration of a source team.
 *
 * Implementations own team-identity validation and every filesystem safety
 * rule, and must never load tasks, messages, sessions, transcripts, agent
 * processes or runtime history: a template is projected from saved
 * configuration and roster metadata only. They must also fail closed, reporting
 * an unavailable source instead of throwing or inventing content.
 */
export interface CustomTeamTemplateSnapshotReader {
  readSnapshot(sourceTeamName: string): Promise<CustomTeamTemplateSnapshotReadOutcome>;
}

/**
 * Immutable identity of one saved template, in the exact shape the persistence
 * layer compares for idempotency.
 *
 * `contentHash` digests the allowlisted content, `nameKey` is the normalized
 * uniqueness key (so display capitalization is not identity) and `description`
 * is the trimmed optional text or `null` when absent.
 */
export interface CustomTeamTemplateIdentityInput {
  contentHash: string;
  nameKey: string;
  description: string | null;
}

/**
 * Trusted hashing for template content and identity.
 *
 * Digests are always produced by trusted main-process code from the validated
 * canonical projection: a renderer-supplied digest is never trusted, and the
 * worker only ever stores a digest it did not derive. Algorithms stay
 * swappable because persistence compares digests for equality only.
 */
export interface CustomTeamTemplateHasher {
  /** Opaque digest of the exact canonical content that will be persisted. */
  hashCanonicalContent(canonicalContent: string): string;
  /**
   * Stable template id for one immutable identity.
   *
   * Deriving the id from content *and* name key *and* description is what makes
   * a retry of the same save idempotent while two different templates can never
   * collide onto one id, even when their team content is identical.
   */
  deriveTemplateId(identity: CustomTeamTemplateIdentityInput): string;
}
