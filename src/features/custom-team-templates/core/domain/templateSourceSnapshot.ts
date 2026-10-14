/**
 * Typed input models for template projection.
 *
 * These describe what a future saved-configuration adapter must provide. The
 * pure domain never reads files, probes presence or touches the runtime; it only
 * interprets this typed snapshot.
 */

/**
 * Narrow roster member metadata.
 *
 * `agentType` and `role` are required for the canonical lead exclusion rule
 * (`isCanonicalSettingsLeadMember`). `removed` marks authoritative tombstones
 * recorded by the source configuration.
 */
export interface RosterMetadataMember {
  name: string;
  role?: string;
  workflow?: string;
  agentType?: string;
  removed?: boolean;
}

/**
 * Authoritative roster metadata state.
 *
 * These three states must stay distinct:
 * - `absent`: no roster metadata was recorded. A prompt-only template is allowed.
 * - `readable`: metadata was read and validated. An empty member list is valid.
 * - `unreadable`: metadata exists but cannot be safely read or is structurally
 *   incomplete. Projection must block saving.
 */
export type RosterMetadataReadResult =
  | { status: 'absent' }
  | { status: 'readable'; members: readonly RosterMetadataMember[] }
  | { status: 'unreadable' };

/** Saved-configuration snapshot for one source team. */
export interface CustomTemplateSourceTeamSnapshot {
  sourceTeamName: string;
  /** Team-level prompt from saved metadata, when a saved configuration exists. */
  teamPrompt?: string;
  roster: RosterMetadataReadResult;
}
