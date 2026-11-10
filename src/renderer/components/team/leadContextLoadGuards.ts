export interface LeadSessionDetailLoadInput {
  tabId: string | null;
  projectId: string | null;
  leadSessionId: string | null;
  enabled: boolean;
}

export interface ResolvedLeadSessionDetailLoadInput {
  tabId: string;
  projectId: string;
  leadSessionId: string;
  enabled: true;
}

export function shouldLoadLeadSessionDetail(
  input: LeadSessionDetailLoadInput
): input is ResolvedLeadSessionDetailLoadInput {
  return Boolean(
    input.enabled && input.tabId?.trim() && input.projectId?.trim() && input.leadSessionId?.trim()
  );
}

export function buildLeadSessionDetailRequestKey(input: {
  tabId: string;
  projectId: string;
  leadSessionId: string;
}): string {
  return `${input.tabId}:${input.projectId}:${input.leadSessionId}`;
}

export function shouldFetchLeadSessionDetail(input: {
  requestedSessionId: string | null;
  loadedSessionId: string | null;
  loading: boolean;
  inFlightOrAttemptedRequestKey: string | null;
  nextRequestKey: string | null;
}): boolean {
  const requested = input.requestedSessionId?.trim() ?? '';
  if (!requested) return false;
  if (input.loading) return false;
  if (input.loadedSessionId === requested) return false;
  if (input.nextRequestKey && input.inFlightOrAttemptedRequestKey === input.nextRequestKey) {
    return false;
  }
  return true;
}

export function deriveLeadContextButtonLabel(input: {
  liveContextUsedPercent?: number | null;
  fullContextUsedPercent?: number | null;
  contextPanelOpen: boolean;
}): string {
  const percent = input.contextPanelOpen
    ? (input.fullContextUsedPercent ?? input.liveContextUsedPercent)
    : input.liveContextUsedPercent;

  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return 'Context';
  }

  return `${percent.toFixed(1)}%`;
}
