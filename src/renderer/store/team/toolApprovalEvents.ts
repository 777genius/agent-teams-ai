import type { ToolApprovalEvent, ToolApprovalRequest } from '@shared/types/team';

interface ApprovalState {
  pendingApprovals: ToolApprovalRequest[];
  resolvedApprovals: Map<string, boolean>;
}

/** Existing approval event projection; dismissal never invents an allow/deny outcome. */
export function applyToolApprovalEvent(
  state: ApprovalState,
  event: ToolApprovalEvent
): Partial<ApprovalState> {
  if ('autoResolved' in event && event.autoResolved) {
    const next = new Map(state.resolvedApprovals);
    next.set(event.requestId, event.reason !== 'timeout_deny');
    return {
      pendingApprovals: state.pendingApprovals.filter(
        (request) => !(request.runId === event.runId && request.requestId === event.requestId)
      ),
      resolvedApprovals: next,
    };
  }
  if ('dismissed' in event && event.dismissed)
    return {
      pendingApprovals: state.pendingApprovals.filter(
        (request) =>
          !(
            request.teamName === event.teamName &&
            request.runId === event.runId &&
            (event.requestId === undefined || request.requestId === event.requestId)
          )
      ),
    };
  return {
    pendingApprovals: [...state.pendingApprovals, event as ToolApprovalRequest],
  };
}
