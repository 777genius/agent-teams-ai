import {
  type DecideHostedTeamApprovalResult,
  type GetHostedTeamApprovalPageResult,
  type GetHostedTeamApprovalPreviewResult,
  HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
  HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
  HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
  type HostedTeamApprovalDecisionCommand,
  type HostedTeamApprovalPageRequest,
  type HostedTeamApprovalPreviewRequest,
  parseHostedTeamApprovalDecisionCommand,
  parseHostedTeamApprovalDecisionReceipt,
  parseHostedTeamApprovalErrorEnvelope,
  parseHostedTeamApprovalPage,
  parseHostedTeamApprovalPageRequest,
  parseHostedTeamApprovalPreview,
  parseHostedTeamApprovalPreviewRequest,
} from '../../contracts';

import type {
  HostedTeamApprovalHttpResponse,
  HostedTeamApprovalTransport,
  HostedTeamApprovalTransportDependencies,
  HostedTeamApprovalTransportOptions,
} from '../ports/HostedTeamApprovalTransportPorts';

const JSON_HEADERS = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
const CSRF_HEADER = 'x-agent-teams-csrf';
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

function unavailable<T extends { readonly kind: string }>(retryAfterMs?: number): T {
  return (
    retryAfterMs === undefined
      ? Object.freeze({ kind: 'unavailable' })
      : Object.freeze({ kind: 'unavailable', retryAfterMs })
  ) as T;
}

function readCsrfToken(dependencies: HostedTeamApprovalTransportDependencies): string | null {
  try {
    const value: unknown = dependencies.getCsrfToken();
    return typeof value === 'string' && CSRF_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function readJson(response: HostedTeamApprovalHttpResponse): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pageError(status: number, value: unknown): GetHostedTeamApprovalPageResult {
  const envelope = parseHostedTeamApprovalErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  const reason = envelope.value.error.reason;
  if (status === 400 && reason === 'approval_page_request_invalid') {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (status === 404 && reason === 'team_not_found') {
    return Object.freeze({ kind: 'not_found' });
  }
  return status === 503 && reason === 'team_approval_unavailable'
    ? unavailable(envelope.value.error.retryAfterMs)
    : unavailable();
}

function previewError(status: number, value: unknown): GetHostedTeamApprovalPreviewResult {
  const envelope = parseHostedTeamApprovalErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  const reason = envelope.value.error.reason;
  if (status === 400 && reason === 'approval_preview_request_invalid') {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (status === 404 && reason === 'approval_not_found') {
    return Object.freeze({ kind: 'not_found' });
  }
  if (status === 409 && reason === 'stale_generation') {
    return envelope.value.currentGeneration === undefined
      ? unavailable()
      : Object.freeze({
          kind: 'stale_generation',
          currentGeneration: envelope.value.currentGeneration,
        });
  }
  return status === 503 && reason === 'team_approval_unavailable'
    ? unavailable(envelope.value.error.retryAfterMs)
    : unavailable();
}

function decisionError(status: number, value: unknown): DecideHostedTeamApprovalResult {
  const envelope = parseHostedTeamApprovalErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  const reason = envelope.value.error.reason;
  if (status === 400 && reason === 'approval_decision_invalid') {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (status === 404 && reason === 'approval_not_found') {
    return Object.freeze({ kind: 'not_found' });
  }
  if (status === 410 && reason === 'approval_expired') {
    return Object.freeze({ kind: 'expired' });
  }
  if (status === 503 && reason === 'team_approval_unavailable') {
    return unavailable(envelope.value.error.retryAfterMs);
  }
  if (status !== 409) return unavailable();
  if (reason === 'stale_generation') {
    return envelope.value.currentGeneration === undefined
      ? unavailable()
      : Object.freeze({
          kind: 'stale_generation',
          currentGeneration: envelope.value.currentGeneration,
        });
  }
  if (reason === 'approval_already_resolved') {
    return envelope.value.currentGeneration === undefined ||
      envelope.value.resolvedDecision === undefined
      ? unavailable()
      : Object.freeze({
          kind: 'already_resolved',
          generation: envelope.value.currentGeneration,
          decision: envelope.value.resolvedDecision,
        });
  }
  return reason === 'idempotency_mismatch'
    ? Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' })
    : unavailable();
}

export function createHostedTeamApprovalTransport(
  dependencies: HostedTeamApprovalTransportDependencies
): HostedTeamApprovalTransport {
  const post = async (
    route: string,
    body: unknown,
    options: HostedTeamApprovalTransportOptions | undefined,
    csrfToken: string
  ): Promise<HostedTeamApprovalHttpResponse | null> => {
    try {
      return await dependencies.fetch(route, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: Object.freeze({
          ...JSON_HEADERS,
          [CSRF_HEADER]: csrfToken,
        }),
        body: JSON.stringify(body),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      return null;
    }
  };

  return Object.freeze({
    async getPage(
      requestValue: HostedTeamApprovalPageRequest,
      options?: HostedTeamApprovalTransportOptions
    ) {
      const request = parseHostedTeamApprovalPageRequest(requestValue);
      if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null) return unavailable<GetHostedTeamApprovalPageResult>();
      const response = await post(
        HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        request.value,
        options,
        csrfToken
      );
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      if (response === null) {
        return unavailable<GetHostedTeamApprovalPageResult>();
      }
      const value = await readJson(response);
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      if (response.status !== 200) return pageError(response.status, value);
      const page = parseHostedTeamApprovalPage(value);
      return page.ok && page.value.teamId === request.value.teamId
        ? Object.freeze({ kind: 'success', page: page.value })
        : unavailable<GetHostedTeamApprovalPageResult>();
    },

    async getPreview(
      requestValue: HostedTeamApprovalPreviewRequest,
      options?: HostedTeamApprovalTransportOptions
    ) {
      const request = parseHostedTeamApprovalPreviewRequest(requestValue);
      if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null) return unavailable<GetHostedTeamApprovalPreviewResult>();
      const response = await post(
        HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
        request.value,
        options,
        csrfToken
      );
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      if (response === null) {
        return unavailable<GetHostedTeamApprovalPreviewResult>();
      }
      const value = await readJson(response);
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      if (response.status !== 200) return previewError(response.status, value);
      const preview = parseHostedTeamApprovalPreview(value);
      return preview.ok &&
        preview.value.teamId === request.value.teamId &&
        preview.value.runId === request.value.expectedRunId &&
        preview.value.approvalId === request.value.approvalId &&
        preview.value.generation === request.value.expectedGeneration
        ? Object.freeze({ kind: 'success', preview: preview.value })
        : unavailable<GetHostedTeamApprovalPreviewResult>();
    },

    async decide(
      commandValue: HostedTeamApprovalDecisionCommand,
      options?: HostedTeamApprovalTransportOptions
    ) {
      const command = parseHostedTeamApprovalDecisionCommand(commandValue);
      if (!command.ok) return Object.freeze({ kind: 'invalid_request' });
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null || options?.signal?.aborted) {
        return unavailable<DecideHostedTeamApprovalResult>();
      }
      const response = await post(
        HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
        command.value,
        options,
        csrfToken
      );
      if (response === null) return unavailable<DecideHostedTeamApprovalResult>();
      const value = await readJson(response);
      if (response.status !== 200) return decisionError(response.status, value);
      const receipt = parseHostedTeamApprovalDecisionReceipt(value);
      if (
        !receipt.ok ||
        receipt.value.teamId !== command.value.teamId ||
        receipt.value.runId !== command.value.expectedRunId ||
        receipt.value.approvalId !== command.value.approvalId ||
        receipt.value.generation !== command.value.expectedGeneration ||
        receipt.value.decision !== command.value.decision
      ) {
        return unavailable<DecideHostedTeamApprovalResult>();
      }
      return receipt.value.outcome === 'committed'
        ? Object.freeze({ kind: 'committed', receipt: receipt.value })
        : Object.freeze({ kind: 'idempotent_replay', receipt: receipt.value });
    },
  });
}
