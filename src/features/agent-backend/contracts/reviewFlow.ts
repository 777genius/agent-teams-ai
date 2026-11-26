/** Public product policy; original owner, scopes, grants and fanout targets remain inside Host. */
export interface BackendReviewFlowSettings {
  reviewFlow: 'agent_approval' | 'human_approval' | 'lead_then_human';
  reviewFlowPrompt: string;
}
export interface BackendReviewFlowView {
  kind: 'review-flow';
  settings: BackendReviewFlowSettings | null;
  unreadable?: true;
  projectTeam?: {
    saved: boolean;
    settings: BackendReviewFlowSettings | null;
    unreadable?: true;
    projects: { executionHandleId: string; projectPath: string }[];
  };
  /** Explicit matching Save may continue this original policy; ordinary reads never do. */
  pending?: { commandId: string; settings: BackendReviewFlowSettings | null };
}
