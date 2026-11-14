/** Consumer-owned position in one captured Team's volatile product read stream. */
export interface BackendTeamPosition {
  streamId: string;
  sequence: number;
  cursor: string;
}
export const backendTeamConversationGaps = [
  'legacy-history', 'undated', 'retention', 'oversized', 'unattributed',
  'storage', 'state-unpublished', 'unsupported',
] as const;
/** Derived text invalidation only; never a Team product position or outcome. */
export interface BackendTeamConversation {
  revision: string;
  gaps: (typeof backendTeamConversationGaps)[number][];
}
export interface BackendTeamChanges extends BackendTeamPosition {
  events: { sequence: number; eventId: string; kind: 'invalidate' }[];
  gap?: { reason: 'initial' | 'cursor' | 'retention' };
  conversation?: BackendTeamConversation;
}
