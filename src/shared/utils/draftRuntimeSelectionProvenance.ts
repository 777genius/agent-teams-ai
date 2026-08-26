import {
  createUnknownLeadRuntimeSelectionProvenance,
  createUnknownMemberRuntimeSelectionProvenance,
  normalizeTeamLeadRuntimeSelectionProvenance,
  normalizeTeamMemberRuntimeSelectionProvenance,
} from './teamMemberRuntimeSelectionProvenance';

import type {
  TeamCreateConfigRequest,
  TeamLeadRuntimeSelectionProvenance,
  TeamMemberRuntimeSelectionProvenance,
} from '@shared/types';

export type DraftLeadRuntimeSelectionIntent = Pick<
  TeamLeadRuntimeSelectionProvenance,
  'providerBackendId' | 'model' | 'effort'
>;

export type DraftMemberRuntimeSelectionIntent = Pick<
  TeamMemberRuntimeSelectionProvenance,
  'providerBackendId' | 'model' | 'effort'
>;

interface DraftProvenanceInput<TIntent> {
  supplied: boolean;
  value: unknown;
  /** Omit when an old payload does not carry enough information to recover intent safely. */
  missingIntent?: TIntent;
  missingReason?: 'absent' | 'partial';
}

export interface DraftRuntimeSelectionProvenanceInputs {
  lead: DraftProvenanceInput<DraftLeadRuntimeSelectionIntent>;
  members: readonly DraftProvenanceInput<DraftMemberRuntimeSelectionIntent>[];
}

function materializeLeadProvenance(
  input: DraftProvenanceInput<DraftLeadRuntimeSelectionIntent>
): TeamLeadRuntimeSelectionProvenance {
  if (input.supplied) {
    return (
      normalizeTeamLeadRuntimeSelectionProvenance(input.value) ??
      createUnknownLeadRuntimeSelectionProvenance('invalid')
    );
  }
  return input.missingIntent
    ? { version: 1, ...input.missingIntent }
    : createUnknownLeadRuntimeSelectionProvenance(input.missingReason ?? 'absent');
}

function materializeMemberProvenance(
  input: DraftProvenanceInput<DraftMemberRuntimeSelectionIntent>
): TeamMemberRuntimeSelectionProvenance {
  if (input.supplied) {
    return (
      normalizeTeamMemberRuntimeSelectionProvenance(input.value) ??
      createUnknownMemberRuntimeSelectionProvenance('invalid')
    );
  }
  return input.missingIntent
    ? { version: 1, ...input.missingIntent }
    : createUnknownMemberRuntimeSelectionProvenance(input.missingReason ?? 'absent');
}

/**
 * Materializes draft provenance only from boundary-owned intent. Concrete values
 * are deliberately not inspected because they may already be resolved defaults
 * or inherited values in legacy payloads.
 */
export function materializeDraftRuntimeSelectionProvenance(
  request: TeamCreateConfigRequest,
  inputs: DraftRuntimeSelectionProvenanceInputs
): TeamCreateConfigRequest {
  if (inputs.members.length !== request.members.length) {
    throw new Error('Draft member provenance inputs must match the draft roster');
  }

  return {
    ...request,
    leadRuntimeSelectionProvenance: materializeLeadProvenance(inputs.lead),
    members: request.members.map((member, index) => ({
      ...member,
      runtimeSelectionProvenance: materializeMemberProvenance(inputs.members[index]!),
    })),
  };
}
