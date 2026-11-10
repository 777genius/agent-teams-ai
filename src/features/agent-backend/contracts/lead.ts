import type { LeadContextUsage } from '@shared/types/team';
export interface BackendLeadLaunch {
  launchId: string;
  rosterRevision: string;
}
export interface BackendLeadActivity {
  kind: 'team-lead-activity';
  state: 'active' | 'idle' | 'offline';
  launch: BackendLeadLaunch | null;
}
export interface BackendLeadContext {
  kind: 'team-lead-context';
  usage: LeadContextUsage | null;
  launch: BackendLeadLaunch | null;
}
