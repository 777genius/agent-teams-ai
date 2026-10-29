/** Consumer-owned position in one captured Team's volatile product read stream. */
export interface BackendTeamPosition {
  streamId: string;
  sequence: number;
  cursor: string;
}
export interface BackendTeamChanges extends BackendTeamPosition {
  events: { sequence: number; eventId: string; kind: 'invalidate' }[];
  gap?: { reason: 'initial' | 'cursor' | 'retention' };
}
