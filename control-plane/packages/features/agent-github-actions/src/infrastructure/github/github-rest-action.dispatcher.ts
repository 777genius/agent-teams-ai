import {
  createSafeError,
  isSafeError,
  type SafeError,
} from "@agent-teams-control-plane/shared";

import type {
  GitHubCheckRunCreateOrUpdatePayload,
  GitHubIssueCommentCreatePayload,
  GitHubPullRequestReviewCreatePayload,
  GitHubPullRequestTopLevelCommentCreatePayload,
} from "../../domain/index.js";
import type {
  GitHubActionDispatchResult,
  GitHubActionDispatcher,
} from "../../application/ports/github-action-dispatcher.port.js";
import type { AgentGitHubActionsSettings } from "../../application/ports/policies.js";

type FetchLike = typeof fetch;

type GitHubRestSuccessBody = {
  id?: number | string;
  html_url?: string;
};

export class GitHubRestActionDispatcher implements GitHubActionDispatcher {
  public constructor(
    private readonly settings: AgentGitHubActionsSettings,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  public async dispatch(
    input: Parameters<GitHubActionDispatcher["dispatch"]>[0],
  ): Promise<GitHubActionDispatchResult> {
    try {
      const request = buildRequest(input);
      const response = await this.fetchImpl(request.url, {
        body: JSON.stringify(request.body),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${input.tokenLease.token}`,
          "Content-Type": "application/json",
          "User-Agent": "agent-teams-control-plane",
          "X-GitHub-Api-Version": this.settings.githubRestApiVersion() ?? "2022-11-28",
        },
        method: request.method,
      });
      const requestId = response.headers.get("x-github-request-id") ?? undefined;
      if (!response.ok) {
        return mapFailureResponse({
          requestId,
          response,
        });
      }
      const body = (await readJsonResponse(response)) as GitHubRestSuccessBody;
      return {
        githubStatusCode: response.status,
        kind: "success",
        ...(input.actionType === "github.check_run.create_or_update" &&
        body.id !== undefined
          ? { githubCheckRunId: String(body.id) }
          : {}),
        ...(body.id === undefined ? {} : { githubDeliveryId: String(body.id) }),
        ...(requestId === undefined ? {} : { githubRequestId: requestId }),
        ...(typeof body.html_url === "string" ? { githubUrl: body.html_url } : {}),
      };
    } catch (error) {
      if (isSafeError(error)) {
        return {
          kind: "failure",
          safeError: error,
        };
      }
      return mapUnknownTransportFailure({
        actionType: input.actionType,
        checkRunId: input.checkRunId,
      });
    }
  }
}

function buildRequest(input: Parameters<GitHubActionDispatcher["dispatch"]>[0]): {
  method: "PATCH" | "POST";
  url: string;
  body: Record<string, unknown>;
} {
  const base = `https://api.github.com/repos/${encodeURIComponent(input.target.owner)}/${encodeURIComponent(input.target.repo)}`;
  if (input.actionType === "github.issue_comment.create") {
    const payload = input.payload as GitHubIssueCommentCreatePayload;
    return {
      body: { body: requireRenderedBody(input.renderedBody) },
      method: "POST",
      url: `${base}/issues/${payload.issueNumber}/comments`,
    };
  }
  if (input.actionType === "github.pull_request_comment.create_top_level") {
    const payload = input.payload as GitHubPullRequestTopLevelCommentCreatePayload;
    return {
      body: { body: requireRenderedBody(input.renderedBody) },
      method: "POST",
      url: `${base}/issues/${payload.pullRequestNumber}/comments`,
    };
  }
  if (input.actionType === "github.pull_request_review.create") {
    const payload = input.payload as GitHubPullRequestReviewCreatePayload;
    return {
      body: { body: requireRenderedBody(input.renderedBody), event: payload.event },
      method: "POST",
      url: `${base}/pulls/${payload.pullRequestNumber}/reviews`,
    };
  }
  const payload = input.payload as GitHubCheckRunCreateOrUpdatePayload;
  const body = buildCheckRunBody(
    payload,
    input.actionRequestId,
    requireRenderedBody(input.renderedBody),
    input.checkRunId === undefined ? "create" : "update",
  );
  if (input.checkRunId !== undefined) {
    return {
      body,
      method: "PATCH",
      url: `${base}/check-runs/${input.checkRunId}`,
    };
  }
  return {
    body,
    method: "POST",
    url: `${base}/check-runs`,
  };
}

function buildCheckRunBody(
  payload: GitHubCheckRunCreateOrUpdatePayload,
  actionRequestId: string,
  renderedBody: string,
  mode: "create" | "update",
): Record<string, unknown> {
  return {
    external_id: actionRequestId,
    name: payload.name,
    output: {
      summary: renderedBody,
      title: payload.title ?? payload.name,
    },
    status: payload.status,
    ...(mode === "create" ? { head_sha: payload.headSha } : {}),
    ...(payload.conclusion === undefined ? {} : { conclusion: payload.conclusion }),
  };
}

function requireRenderedBody(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_RENDERED_BODY_REQUIRED",
      message: "Rendered GitHub action body is required.",
    });
  }
  return value;
}

async function mapFailureResponse(input: {
  response: Response;
  requestId: string | undefined;
}): Promise<GitHubActionDispatchResult> {
  const retryAfterMs = parseRetryAfterMs(input.response.headers);
  const rateLimitResetMs = parseRateLimitResetMs(input.response.headers);
  const backoffMs = retryAfterMs ?? rateLimitResetMs;
  const status = input.response.status;
  const message = await readProviderMessage(input.response);
  const secondaryRateLimit =
    status === 429 ||
    (status === 403 && backoffMs !== undefined) ||
    /secondary rate limit|rate limit/i.test(message);

  if (secondaryRateLimit) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_RATE_LIMITED",
      message: "GitHub action dispatch was rate limited.",
      requestId: input.requestId,
      retryAfterMs: backoffMs ?? 60_000,
      retryable: true,
      status,
    });
  }
  if (status >= 500) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_PROVIDER_UNAVAILABLE",
      message: "GitHub action dispatch provider failed.",
      requestId: input.requestId,
      retryable: true,
      status,
    });
  }
  if (status === 401 || status === 403) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_PERMISSION_DENIED",
      message: "GitHub action dispatch was denied by GitHub permissions.",
      requestId: input.requestId,
      status,
    });
  }
  if (status === 404) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_RESOURCE_NOT_FOUND",
      message: "GitHub action target resource was not found.",
      requestId: input.requestId,
      status,
    });
  }
  if (status === 410) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_RESOURCE_GONE",
      message: "GitHub action target resource is gone.",
      requestId: input.requestId,
      status,
    });
  }
  if (status === 422) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_VALIDATION_FAILED",
      message: "GitHub rejected the action payload.",
      requestId: input.requestId,
      status,
    });
  }
  return failure({
    code: "CONTROL_PLANE_GITHUB_ACTION_PROVIDER_REJECTED",
    message: "GitHub rejected the action request.",
    requestId: input.requestId,
    status,
  });
}

function mapUnknownTransportFailure(input: {
  actionType: string;
  checkRunId: string | undefined;
}): GitHubActionDispatchResult {
  if (
    input.actionType === "github.issue_comment.create" ||
    input.actionType === "github.pull_request_comment.create_top_level" ||
    input.actionType === "github.pull_request_review.create"
  ) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_UNKNOWN_RESULT",
      message:
        "GitHub action result is unknown and will not be retried without marker lookup.",
    });
  }
  if (input.checkRunId === undefined) {
    return failure({
      code: "CONTROL_PLANE_GITHUB_ACTION_UNKNOWN_RESULT",
      message:
        "GitHub check run create result is unknown and will not be retried without a stored check_run_id.",
    });
  }
  return failure({
    code: "CONTROL_PLANE_GITHUB_ACTION_TRANSPORT_FAILED",
    message: "GitHub check run update transport failed.",
    retryable: true,
  });
}

function failure(input: {
  code: string;
  message: string;
  status?: number | undefined;
  requestId?: string | undefined;
  retryable?: boolean | undefined;
  retryAfterMs?: number | undefined;
}): GitHubActionDispatchResult {
  const safeError: SafeError = createSafeError({
    category: "external",
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    safeDetails: {
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  });
  return {
    kind: "failure",
    safeError,
    ...(input.requestId === undefined ? {} : { githubRequestId: input.requestId }),
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
    ...(input.status === undefined ? {} : { githubStatusCode: input.status }),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function readProviderMessage(response: Response): Promise<string> {
  const body = await readJsonResponse(response);
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return "";
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return undefined;
}

function parseRateLimitResetMs(headers: Headers): number | undefined {
  if (headers.get("x-ratelimit-remaining") !== "0") {
    return undefined;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset === null) {
    return undefined;
  }
  const seconds = Number(reset);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.max(0, seconds * 1000 - Date.now());
}
