export type TeamMemberRuntimeSelectionKind = 'explicit' | 'inherited' | 'unknown';

export interface TeamMemberRuntimeSelectionProvenance {
  version: 1;
  providerBackendId: TeamMemberRuntimeSelectionKind;
  model: TeamMemberRuntimeSelectionKind;
  effort: TeamMemberRuntimeSelectionKind;
  /** Present only on canonical fail-closed legacy/invalid selections. */
  unknownReason?: 'absent' | 'invalid' | 'partial';
}

export interface TeamMemberRuntimeSelectionProvenanceCarrier {
  runtimeSelectionProvenance?: TeamMemberRuntimeSelectionProvenance;
}

export type TeamLeadRuntimeSelectionKind = 'default' | 'explicit' | 'unknown';

export interface TeamLeadRuntimeSelectionProvenance {
  version: 1;
  providerBackendId: TeamLeadRuntimeSelectionKind;
  model: TeamLeadRuntimeSelectionKind;
  effort: TeamLeadRuntimeSelectionKind;
  /** Present only on canonical fail-closed legacy/invalid selections. */
  unknownReason?: 'absent' | 'invalid' | 'partial';
}

export interface TeamLeadRuntimeSelectionProvenanceCarrier {
  leadRuntimeSelectionProvenance?: TeamLeadRuntimeSelectionProvenance;
}
