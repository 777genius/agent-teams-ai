import {
  createSafeError,
  isSafeError,
  parseAgentActionId,
  SystemClock,
  toSafeError,
  type Clock,
  type SafeError,
} from "@agent-teams-control-plane/shared";

import {
  bodyFromActionPayload,
  capabilityForGitHubActionType,
  renderGitHubActionBody,
  type GitHubActionPayload,
} from "../../domain/index.js";
import type { GitHubActionContentStore } from "../ports/github-action-content-store.port.js";
import type { GitHubActionDispatcher } from "../ports/github-action-dispatcher.port.js";
import type { GitHubInstallationTokenBrokerPort } from "../ports/github-installation-token-broker.port.js";
import type { GitHubActionRepository } from "../ports/github-action.repository.js";
import {
  agentGitHubActionsWorkerPausedError,
  type AgentGitHubActionsAuditLog,
  type AgentGitHubActionsFeatureGatePolicy,
  type AgentGitHubActionsSettings,
} from "../ports/policies.js";
import type { TargetPolicyEvaluatorPort } from "../ports/target-policy-evaluator.port.js";
import type { TransactionRunner } from "../ports/transaction-runner.js";
import { decodeGitHubActionPayloadEnvelope } from "./action-content-codec.js";

export type DispatchGitHubActionInput = Readonly<{
  actionRequestId: string;
  attemptNumber: number;
  correlationId?: string;
}>;

export type DispatchGitHubActionResult =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "retry"; safeError: SafeError; retryAfterMs?: number }>
  | Readonly<{ kind: "dead-letter"; safeError: SafeError }>;

export class DispatchGitHubActionUseCase {
  public constructor(
    private readonly featureGate: AgentGitHubActionsFeatureGatePolicy,
    private readonly settings: AgentGitHubActionsSettings,
    private readonly repository: GitHubActionRepository,
    private readonly contentStore: GitHubActionContentStore,
    private readonly targetPolicyEvaluator: TargetPolicyEvaluatorPort,
    private readonly tokenBroker: GitHubInstallationTokenBrokerPort,
    private readonly dispatcher: GitHubActionDispatcher,
    private readonly transactions: TransactionRunner,
    private readonly auditLog: AgentGitHubActionsAuditLog,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  public async execute(
    input: DispatchGitHubActionInput,
  ): Promise<DispatchGitHubActionResult> {
    if (!this.featureGate.isEnabled("agent-github-actions")) {
      return { kind: "retry", safeError: agentGitHubActionsWorkerPausedError() };
    }

    const actionRequestId = parseAgentActionId(input.actionRequestId);
    if (!actionRequestId.ok) {
      return { kind: "dead-letter", safeError: actionRequestId.error };
    }
    const view = await this.repository.findForDispatch({
      actionRequestId: actionRequestId.value,
    });
    if (view === undefined) {
      return {
        kind: "dead-letter",
        safeError: createSafeError({
          category: "not-found",
          code: "CONTROL_PLANE_GITHUB_ACTION_REQUEST_NOT_FOUND",
          message: "GitHub action request was not found.",
        }),
      };
    }
    if (view.request.status === "succeeded") {
      return { kind: "completed" };
    }
    if (view.request.status === "failed" || view.request.status === "dead_lettered") {
      return {
        kind: "dead-letter",
        safeError:
          view.request.safeError ??
          createSafeError({
            category: "external",
            code: "CONTROL_PLANE_GITHUB_ACTION_ALREADY_TERMINAL",
            message: "GitHub action request is already terminal.",
          }),
      };
    }

    const nowMs = this.clock.nowMs();
    await this.transactions.runInTransaction(async (context) => {
      await this.repository.recordAttemptStarted(
        {
          actionRequestId: view.request.id,
          attemptNumber: input.attemptNumber,
          startedAtMs: nowMs,
        },
        context,
      );
      await this.repository.markDispatching(
        { actionRequestId: view.request.id, nowMs },
        context,
      );
    });
    await this.auditLog.record({
      actionRequestId: view.request.id,
      actorKind: "system",
      eventType: "github_action.dispatch_started",
      integrationTargetId: view.request.integrationTargetId,
      status: "dispatching",
      workspaceId: view.request.workspaceId,
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: input.correlationId }),
    });

    try {
      const loaded = await this.contentStore.load({
        ref: {
          ciphertextSha256: view.request.externalContentIntegrityHash,
          id: view.request.externalContentRefId,
        },
      });
      const envelope = decodeGitHubActionPayloadEnvelope(loaded.plaintext);
      if (envelope.actionType !== view.request.actionType) {
        throw createSafeError({
          category: "conflict",
          code: "CONTROL_PLANE_GITHUB_ACTION_TYPE_MISMATCH",
          message: "Stored GitHub action payload type does not match the request.",
        });
      }

      const policyDenied = await this.recheckPolicy(view, input.correlationId);
      if (policyDenied !== undefined) {
        return this.finishTerminalFailure({
          attemptNumber: input.attemptNumber,
          safeError: policyDenied,
          status: "dead_lettered",
          view,
        });
      }

      const capability = capabilityForGitHubActionType(view.request.actionType);
      const lease = await this.tokenBroker.issue({
        capability,
        desktopClientSubjectId: `desktop-client:${view.request.assertedByDesktopClientId}`,
        subjectId: view.request.requestedBySubjectId,
        subjectKind: view.request.requestedBySubjectKind,
        targetId: view.request.integrationTargetId,
        workspaceId: view.request.workspaceId,
        ...(input.correlationId === undefined
          ? {}
          : { correlationId: input.correlationId }),
        ...(view.request.attribution.agentId === undefined
          ? {}
          : { agentSubjectId: view.request.attribution.agentId }),
        ...(view.request.attribution.teamId === undefined
          ? {}
          : { teamSubjectId: view.request.attribution.teamId }),
      });
      const dispatch = await this.dispatcher.dispatch({
        actionRequestId: view.request.id,
        actionType: view.request.actionType,
        payload: envelope.payload,
        target: {
          owner: view.target.owner,
          repo: view.target.repo,
        },
        tokenLease: lease,
        ...(view.request.githubCheckRunId === undefined
          ? {}
          : { checkRunId: view.request.githubCheckRunId }),
        ...optionalRenderedBody(view.request.id, envelope.payload, {
          allowedAvatarOrigins: this.settings.agentAvatarAllowedOrigins(),
          attribution: view.request.attribution,
          defaultAgentAvatarUrl: requiredDefaultAvatar(this.settings),
        }),
      });

      if (dispatch.kind === "success") {
        return this.finishSuccess({
          attemptNumber: input.attemptNumber,
          dispatch,
          view,
        });
      }
      if (dispatch.safeError.retryable) {
        return this.finishRetryableFailure({
          attemptNumber: input.attemptNumber,
          dispatch,
          view,
        });
      }
      return this.finishTerminalFailure({
        attemptNumber: input.attemptNumber,
        safeError: dispatch.safeError,
        status: "dead_lettered",
        view,
        ...(dispatch.githubRequestId === undefined
          ? {}
          : { githubRequestId: dispatch.githubRequestId }),
        ...(dispatch.githubStatusCode === undefined
          ? {}
          : { githubStatusCode: dispatch.githubStatusCode }),
      });
    } catch (error) {
      const safeError = isSafeError(error) ? error : toSafeError(error);
      if (safeError.retryable) {
        return this.finishRetryableFailure({
          attemptNumber: input.attemptNumber,
          dispatch: { kind: "failure", safeError },
          view,
        });
      }
      return this.finishTerminalFailure({
        attemptNumber: input.attemptNumber,
        safeError,
        status: "dead_lettered",
        view,
      });
    }
  }

  private async recheckPolicy(
    view: NonNullable<Awaited<ReturnType<GitHubActionRepository["findForDispatch"]>>>,
    correlationId: string | undefined,
  ): Promise<SafeError | undefined> {
    const policy = await this.targetPolicyEvaluator.evaluate({
      capability: capabilityForGitHubActionType(view.request.actionType),
      desktopClientSubjectId: `desktop-client:${view.request.assertedByDesktopClientId}`,
      subjectId: view.request.requestedBySubjectId,
      subjectKind: view.request.requestedBySubjectKind,
      targetId: view.request.integrationTargetId,
      workspaceId: view.request.workspaceId,
      ...(view.request.attribution.agentId === undefined
        ? {}
        : { agentSubjectId: view.request.attribution.agentId }),
      ...(view.request.attribution.teamId === undefined
        ? {}
        : { teamSubjectId: view.request.attribution.teamId }),
    });
    if (policy.allowed) {
      return undefined;
    }
    const safeError = createSafeError({
      category: "authorization",
      code: policy.reasonCode,
      message: "GitHub action dispatch is not authorized for this target.",
      safeDetails: { policyVersion: policy.policyVersion },
    });
    await this.auditLog.record({
      actionRequestId: view.request.id,
      actorKind: "system",
      eventType: "github_action.dispatch_denied",
      integrationTargetId: view.request.integrationTargetId,
      safeErrorCode: safeError.code,
      status: "denied",
      workspaceId: view.request.workspaceId,
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    return safeError;
  }

  private async finishSuccess(input: {
    view: NonNullable<Awaited<ReturnType<GitHubActionRepository["findForDispatch"]>>>;
    attemptNumber: number;
    dispatch: Extract<
      Awaited<ReturnType<GitHubActionDispatcher["dispatch"]>>,
      { kind: "success" }
    >;
  }): Promise<DispatchGitHubActionResult> {
    const finishedAtMs = this.clock.nowMs();
    await this.transactions.runInTransaction(async (context) => {
      await this.repository.finishAttempt(
        {
          actionRequestId: input.view.request.id,
          attemptNumber: input.attemptNumber,
          finishedAtMs,
          status: "succeeded",
          ...(input.dispatch.githubRequestId === undefined
            ? {}
            : { githubRequestId: input.dispatch.githubRequestId }),
          ...(input.dispatch.githubStatusCode === undefined
            ? {}
            : { githubStatusCode: input.dispatch.githubStatusCode }),
        },
        context,
      );
      await this.contentStore.shred({
        context,
        ref: {
          ciphertextSha256: input.view.request.externalContentIntegrityHash,
          id: input.view.request.externalContentRefId,
        },
      });
      await this.repository.markSucceeded(
        {
          actionRequestId: input.view.request.id,
          contentShredded: true,
          nowMs: finishedAtMs,
          ...(input.dispatch.githubCheckRunId === undefined
            ? {}
            : { githubCheckRunId: input.dispatch.githubCheckRunId }),
          ...(input.dispatch.githubDeliveryId === undefined
            ? {}
            : { githubDeliveryId: input.dispatch.githubDeliveryId }),
          ...(input.dispatch.githubUrl === undefined
            ? {}
            : { githubUrl: input.dispatch.githubUrl }),
        },
        context,
      );
    });
    await this.auditLog.record({
      actionRequestId: input.view.request.id,
      actorKind: "system",
      eventType: "github_action.dispatch_succeeded",
      integrationTargetId: input.view.request.integrationTargetId,
      status: "succeeded",
      workspaceId: input.view.request.workspaceId,
    });
    return { kind: "completed" };
  }

  private async finishRetryableFailure(input: {
    view: NonNullable<Awaited<ReturnType<GitHubActionRepository["findForDispatch"]>>>;
    attemptNumber: number;
    dispatch: Extract<
      Awaited<ReturnType<GitHubActionDispatcher["dispatch"]>>,
      { kind: "failure" }
    >;
  }): Promise<DispatchGitHubActionResult> {
    const finishedAtMs = this.clock.nowMs();
    await this.transactions.runInTransaction(async (context) => {
      await this.repository.finishAttempt(
        {
          actionRequestId: input.view.request.id,
          attemptNumber: input.attemptNumber,
          finishedAtMs,
          safeError: input.dispatch.safeError,
          status: "retrying",
          ...(input.dispatch.githubRequestId === undefined
            ? {}
            : { githubRequestId: input.dispatch.githubRequestId }),
          ...(input.dispatch.githubStatusCode === undefined
            ? {}
            : { githubStatusCode: input.dispatch.githubStatusCode }),
        },
        context,
      );
      await this.repository.markRetryableFailure(
        {
          actionRequestId: input.view.request.id,
          nowMs: finishedAtMs,
          safeError: input.dispatch.safeError,
        },
        context,
      );
    });
    await this.auditLog.record({
      actionRequestId: input.view.request.id,
      actorKind: "system",
      eventType: "github_action.dispatch_retrying",
      integrationTargetId: input.view.request.integrationTargetId,
      safeErrorCode: input.dispatch.safeError.code,
      status: "failed",
      workspaceId: input.view.request.workspaceId,
    });
    return {
      kind: "retry",
      safeError: input.dispatch.safeError,
      ...(input.dispatch.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: input.dispatch.retryAfterMs }),
    };
  }

  private async finishTerminalFailure(input: {
    view: NonNullable<Awaited<ReturnType<GitHubActionRepository["findForDispatch"]>>>;
    attemptNumber: number;
    safeError: SafeError;
    status: "failed" | "dead_lettered";
    githubStatusCode?: number;
    githubRequestId?: string;
  }): Promise<DispatchGitHubActionResult> {
    const finishedAtMs = this.clock.nowMs();
    await this.transactions.runInTransaction(async (context) => {
      await this.repository.finishAttempt(
        {
          actionRequestId: input.view.request.id,
          attemptNumber: input.attemptNumber,
          finishedAtMs,
          safeError: input.safeError,
          status: input.status === "dead_lettered" ? "dead_lettered" : "failed",
          ...(input.githubRequestId === undefined
            ? {}
            : { githubRequestId: input.githubRequestId }),
          ...(input.githubStatusCode === undefined
            ? {}
            : { githubStatusCode: input.githubStatusCode }),
        },
        context,
      );
      await this.contentStore.shred({
        context,
        ref: {
          ciphertextSha256: input.view.request.externalContentIntegrityHash,
          id: input.view.request.externalContentRefId,
        },
      });
      await this.repository.markTerminalFailure(
        {
          actionRequestId: input.view.request.id,
          contentShredded: true,
          nowMs: finishedAtMs,
          safeError: input.safeError,
          status: input.status,
        },
        context,
      );
    });
    await this.auditLog.record({
      actionRequestId: input.view.request.id,
      actorKind: "system",
      eventType: "github_action.dispatch_dead_lettered",
      integrationTargetId: input.view.request.integrationTargetId,
      safeErrorCode: input.safeError.code,
      status: "failed",
      workspaceId: input.view.request.workspaceId,
    });
    return { kind: "dead-letter", safeError: input.safeError };
  }
}

function optionalRenderedBody(
  actionRequestId: string,
  payload: GitHubActionPayload,
  input: {
    attribution: Parameters<typeof renderGitHubActionBody>[0]["attribution"];
    allowedAvatarOrigins: readonly string[];
    defaultAgentAvatarUrl: string;
  },
): { renderedBody?: string } {
  const body = bodyFromActionPayload(payload);
  if (body === undefined) {
    return {};
  }
  return {
    renderedBody: renderGitHubActionBody({
      actionRequestId,
      attribution: input.attribution,
      body,
      settings: {
        allowedAvatarOrigins: input.allowedAvatarOrigins,
        defaultAgentAvatarUrl: input.defaultAgentAvatarUrl,
      },
    }),
  };
}

function requiredDefaultAvatar(settings: AgentGitHubActionsSettings): string {
  const value = settings.defaultAgentAvatarUrl();
  if (value === undefined) {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_GITHUB_ACTION_DEFAULT_AVATAR_REQUIRED",
      message: "Default Agent Teams avatar URL is required.",
    });
  }
  return value;
}
