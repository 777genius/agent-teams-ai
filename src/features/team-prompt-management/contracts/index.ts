import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

export type TeamManagementChangedField =
  | 'displayName'
  | 'description'
  | 'color'
  | 'leadInstructions'
  | 'members'
  | 'deletedAt';
export interface TeamManagementCommittedChange {
  operationId: string;
  committedAt: string;
  kind: 'created' | 'edited' | 'trashed';
  changedFields: TeamManagementChangedField[];
  roster?: { before: number; after: number; added: number; removed: number; names: string[] };
  context: AppConnectionContext;
}
export interface TeamManagementResult {
  teamName: string;
  configurationRevision: string;
  changed: boolean;
  change?: TeamManagementCommittedChange;
}
export interface TeamManagementTarget {
  teamName: string;
  expectedContext: AppConnectionContext;
  expectedRevision: string;
}
export interface TeamManagementMember {
  name: string;
  role?: string;
  workflow?: string;
}
export interface TeamManagementUpdate extends TeamManagementTarget {
  metadata?: { displayName?: string; description?: string; color?: string };
  leadInstructions?: string;
  members?: TeamManagementMember[];
}
