import {
  createSafeError,
  type AgentActionId,
  type DesktopClientId,
  type ExternalActionContentId,
  type SafeError,
  type UnixMilliseconds,
  type WorkspaceId,
} from "@agent-teams-control-plane/shared";

export type GitHubActionType =
  | "github.issue_comment.create"
  | "github.pull_request_comment.create_top_level"
  | "github.pull_request_review.create"
  | "github.check_run.create_or_update";

export type GitHubActionStatus =
  | "queued"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "dead_lettered";

export type GitHubActionAttemptStatus =
  | "started"
  | "succeeded"
  | "retrying"
  | "failed"
  | "dead_lettered";

export type TrustedRequestSubjectKind = "workspace" | "team" | "agent" | "desktop_client";

export type GitHubActionAttribution = Readonly<{
  agentDisplayName: string;
  agentAvatarUrl?: string;
  agentId?: string;
  teamDisplayName?: string;
  teamId?: string;
}>;

export type GitHubIssueCommentCreatePayload = Readonly<{
  issueNumber: number;
  body: string;
}>;

export type GitHubPullRequestTopLevelCommentCreatePayload = Readonly<{
  pullRequestNumber: number;
  body: string;
}>;

export type GitHubPullRequestReviewCreatePayload = Readonly<{
  pullRequestNumber: number;
  body: string;
  event: "COMMENT";
}>;

export type GitHubCheckRunCreateOrUpdatePayload = Readonly<{
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?:
    | "action_required"
    | "cancelled"
    | "failure"
    | "neutral"
    | "skipped"
    | "success"
    | "timed_out";
  title?: string;
  summary?: string;
  text?: string;
}>;

export type GitHubActionPayload =
  | GitHubIssueCommentCreatePayload
  | GitHubPullRequestTopLevelCommentCreatePayload
  | GitHubPullRequestReviewCreatePayload
  | GitHubCheckRunCreateOrUpdatePayload;

export type GitHubActionRequest = Readonly<{
  id: AgentActionId;
  workspaceId: WorkspaceId;
  integrationTargetId: string;
  actionType: GitHubActionType;
  requestedBySubjectKind: TrustedRequestSubjectKind;
  requestedBySubjectId: string;
  assertedByDesktopClientId: DesktopClientId;
  attribution: GitHubActionAttribution;
  idempotencyKey: string;
  status: GitHubActionStatus;
  externalContentRefId: ExternalActionContentId;
  externalContentIntegrityHash: string;
  githubDeliveryId?: string;
  githubCheckRunId?: string;
  githubUrl?: string;
  safeError?: SafeError;
  attemptCount?: number;
  contentShreddedAtMs?: UnixMilliseconds;
  createdAtMs: UnixMilliseconds;
  updatedAtMs: UnixMilliseconds;
}>;

export type GitHubActionAttempt = Readonly<{
  id: string;
  githubActionRequestId: AgentActionId;
  attemptNumber: number;
  status: GitHubActionAttemptStatus;
  startedAtMs: UnixMilliseconds;
  finishedAtMs?: UnixMilliseconds;
  safeError?: SafeError;
  githubStatusCode?: number;
  githubRequestId?: string;
}>;

export const GITHUB_ACTION_TYPES = [
  "github.issue_comment.create",
  "github.pull_request_comment.create_top_level",
  "github.pull_request_review.create",
  "github.check_run.create_or_update",
] as const satisfies readonly GitHubActionType[];

const maxBodyLength = 60_000;
const maxDisplayNameLength = 120;
const maxCheckNameLength = 120;
const maxCheckOutputFieldLength = 60_000;
const shaLikePattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

export function assertGitHubActionType(value: unknown): GitHubActionType {
  if (isGitHubActionType(value)) {
    return value;
  }
  throw createSafeError({
    category: "validation",
    code: "CONTROL_PLANE_GITHUB_ACTION_TYPE_INVALID",
    message: "GitHub action type is not supported.",
  });
}

export function isGitHubActionType(value: unknown): value is GitHubActionType {
  return GITHUB_ACTION_TYPES.some((type) => type === value);
}

export function capabilityForGitHubActionType(type: GitHubActionType): string {
  if (type === "github.issue_comment.create") {
    return "github.issue_comment.request";
  }
  if (type === "github.pull_request_comment.create_top_level") {
    return "github.pr_comment.request";
  }
  if (type === "github.pull_request_review.create") {
    return "github.pr_review.request";
  }
  return "github.check_run.request";
}

export function validateGitHubActionAttribution(
  attribution: GitHubActionAttribution,
): SafeError | undefined {
  const invalidAgentName = validateDisplayName({
    code: "CONTROL_PLANE_GITHUB_ACTION_AGENT_NAME_INVALID",
    message: "Agent display name is required, single-line, and bounded.",
    value: attribution.agentDisplayName,
  });
  if (invalidAgentName !== undefined) {
    return invalidAgentName;
  }
  if (attribution.teamDisplayName !== undefined) {
    return validateDisplayName({
      code: "CONTROL_PLANE_GITHUB_ACTION_TEAM_NAME_INVALID",
      message: "Team display name must be single-line and bounded when provided.",
      value: attribution.teamDisplayName,
    });
  }
  return undefined;
}

export function decodeGitHubActionPayload(input: {
  actionType: GitHubActionType;
  payload: unknown;
}): GitHubActionPayload {
  if (!isRecord(input.payload)) {
    throw invalidPayload("CONTROL_PLANE_GITHUB_ACTION_PAYLOAD_INVALID");
  }

  if (input.actionType === "github.issue_comment.create") {
    return {
      body: readString(input.payload.body),
      issueNumber: readPositiveInteger(input.payload.issueNumber),
    };
  }
  if (input.actionType === "github.pull_request_comment.create_top_level") {
    return {
      body: readString(input.payload.body),
      pullRequestNumber: readPositiveInteger(input.payload.pullRequestNumber),
    };
  }
  if (input.actionType === "github.pull_request_review.create") {
    return {
      body: readString(input.payload.body),
      event: input.payload.event === "COMMENT" ? "COMMENT" : ("" as "COMMENT"),
      pullRequestNumber: readPositiveInteger(input.payload.pullRequestNumber),
    };
  }
  const checkPayload: Record<string, unknown> = {
    headSha: readString(input.payload.headSha),
    name: readString(input.payload.name),
    status:
      typeof input.payload.status === "string"
        ? (input.payload.status as GitHubCheckRunCreateOrUpdatePayload["status"])
        : ("" as GitHubCheckRunCreateOrUpdatePayload["status"]),
  };
  if (typeof input.payload.conclusion === "string") {
    checkPayload.conclusion = input.payload
      .conclusion as GitHubCheckRunCreateOrUpdatePayload["conclusion"];
  }
  if (typeof input.payload.summary === "string") {
    checkPayload.summary = input.payload.summary;
  }
  if (typeof input.payload.text === "string") {
    checkPayload.text = input.payload.text;
  }
  if (typeof input.payload.title === "string") {
    checkPayload.title = input.payload.title;
  }
  return checkPayload as GitHubCheckRunCreateOrUpdatePayload;
}

export function validateGitHubActionPayload(input: {
  actionType: GitHubActionType;
  payload: GitHubActionPayload;
}): SafeError | undefined {
  if (input.actionType === "github.issue_comment.create") {
    const payload = input.payload as GitHubIssueCommentCreatePayload;
    return validateBodyActionPayload(payload.issueNumber, payload.body);
  }
  if (input.actionType === "github.pull_request_comment.create_top_level") {
    const payload = input.payload as GitHubPullRequestTopLevelCommentCreatePayload;
    return validateBodyActionPayload(payload.pullRequestNumber, payload.body);
  }
  if (input.actionType === "github.pull_request_review.create") {
    const payload = input.payload as GitHubPullRequestReviewCreatePayload;
    if (payload.event !== "COMMENT") {
      return createSafeError({
        category: "validation",
        code: "CONTROL_PLANE_GITHUB_ACTION_REVIEW_EVENT_UNSUPPORTED",
        message: "Only COMMENT pull request reviews are supported.",
      });
    }
    return validateBodyActionPayload(payload.pullRequestNumber, payload.body);
  }
  return validateCheckRunPayload(input.payload as GitHubCheckRunCreateOrUpdatePayload);
}

export function bodyFromActionPayload(payload: GitHubActionPayload): string | undefined {
  return "body" in payload
    ? payload.body
    : (payload.summary ?? payload.title ?? payload.name);
}

function validateDisplayName(input: {
  value: string;
  code: string;
  message: string;
}): SafeError | undefined {
  const normalized = input.value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxDisplayNameLength ||
    hasControlCharacter(normalized)
  ) {
    return createSafeError({
      category: "validation",
      code: input.code,
      message: input.message,
    });
  }
  return undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function validateBodyActionPayload(number: number, body: string): SafeError | undefined {
  if (!Number.isInteger(number) || number <= 0) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_TARGET_NUMBER_INVALID",
      message: "GitHub issue or pull request number must be a positive integer.",
    });
  }
  if (body.trim().length === 0) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_BODY_REQUIRED",
      message: "GitHub action body is required.",
    });
  }
  if (body.length > maxBodyLength) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_BODY_TOO_LARGE",
      message: "GitHub action body is too large.",
    });
  }
  return undefined;
}

function validateCheckRunPayload(
  payload: GitHubCheckRunCreateOrUpdatePayload,
): SafeError | undefined {
  if (payload.name.trim().length === 0 || payload.name.length > maxCheckNameLength) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_CHECK_NAME_INVALID",
      message: "GitHub check run name is required and must be bounded.",
    });
  }
  if (!shaLikePattern.test(payload.headSha)) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_HEAD_SHA_INVALID",
      message: "GitHub check run head SHA is invalid.",
    });
  }
  if (
    payload.status !== "queued" &&
    payload.status !== "in_progress" &&
    payload.status !== "completed"
  ) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_CHECK_STATUS_INVALID",
      message: "GitHub check run status is invalid.",
    });
  }
  if (payload.status !== "completed" && payload.conclusion !== undefined) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_CHECK_CONCLUSION_INVALID",
      message: "GitHub check run conclusion is allowed only for completed checks.",
    });
  }
  if (payload.status === "completed" && payload.conclusion === undefined) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_CHECK_CONCLUSION_REQUIRED",
      message: "GitHub check run conclusion is required for completed checks.",
    });
  }
  if (
    payload.conclusion !== undefined &&
    ![
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "success",
      "timed_out",
    ].includes(payload.conclusion)
  ) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_CHECK_CONCLUSION_INVALID",
      message: "GitHub check run conclusion is invalid.",
    });
  }
  for (const value of [payload.title, payload.summary, payload.text]) {
    if (value !== undefined && value.length > maxCheckOutputFieldLength) {
      return createSafeError({
        category: "validation",
        code: "CONTROL_PLANE_GITHUB_ACTION_CHECK_OUTPUT_TOO_LARGE",
        message: "GitHub check run output is too large.",
      });
    }
  }
  return undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readPositiveInteger(value: unknown): number {
  return Number.isInteger(value) && typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPayload(code: string): SafeError {
  return createSafeError({
    category: "validation",
    code,
    message: "GitHub action payload is invalid.",
  });
}
