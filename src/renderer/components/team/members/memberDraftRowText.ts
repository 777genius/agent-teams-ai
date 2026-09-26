import type { TeamMemberMcpMode, TeamProviderId } from '@shared/types';

type ModelReasonByValue = Partial<Record<string, string | null | undefined>>;
export type ModelReasonByProvider = Partial<Record<TeamProviderId, ModelReasonByValue>>;

export const MEMBER_MCP_SCOPE_LABEL_KEYS = {
  user: 'memberDraft.mcp.scopes.user',
  project: 'memberDraft.mcp.scopes.project',
  local: 'memberDraft.mcp.scopes.local',
} as const;

/** The issue (blocking) and advisory text shown for a member's selected model. */
export function resolveMemberModelReasonTexts(input: {
  providerId: TeamProviderId;
  modelKey: string;
  modelIssueText?: string | null;
  issueByProvider?: ModelReasonByProvider;
  unavailableByProvider?: ModelReasonByProvider;
  advisoryByProvider?: ModelReasonByProvider;
}): { issueText: string | null; advisoryText: string | null } {
  const lookup = (byProvider?: ModelReasonByProvider): string | null =>
    (input.modelKey && byProvider?.[input.providerId]?.[input.modelKey]) || null;
  const issueText =
    input.modelIssueText ??
    lookup(input.unavailableByProvider) ??
    lookup(input.issueByProvider) ??
    null;
  return { issueText, advisoryText: issueText ? null : lookup(input.advisoryByProvider) };
}

export function formatMemberMcpButtonLabel(
  mode: TeamMemberMcpMode,
  serverCount: number,
  labels: { scopes: string; inherit: string }
): string {
  if (mode === 'appOnly') return 'Agent Teams MCP';
  if (mode === 'strictAllowlist') return `MCP ${serverCount || 'strict'}`;
  return mode === 'inheritScopes' ? labels.scopes : labels.inherit;
}
