import { describe, expect, it } from "vitest";

import {
  createSafeError,
  FixedClock,
  toUnixMilliseconds,
} from "@agent-teams-control-plane/shared";

import type { GitHubActionContentStore } from "../ports/github-action-content-store.port.js";
import type { GitHubActionDispatcher } from "../ports/github-action-dispatcher.port.js";
import type { GitHubActionRepository } from "../ports/github-action.repository.js";
import type { AgentGitHubActionsAuditLog } from "../ports/policies.js";
import { encodeGitHubActionPayloadEnvelope } from "./action-content-codec.js";
import { DispatchGitHubActionUseCase } from "./dispatch-github-action.use-case.js";

describe("DispatchGitHubActionUseCase", () => {
  it("dispatches through token broker, renders attribution, and shreds content on success", async () => {
    const harness = createHarness();
    const result = await harness.useCase.execute({
      actionRequestId: "action-1",
      attemptNumber: 2,
    });

    expect(result).toEqual({ kind: "completed" });
    expect(harness.dispatchBodies[0]).toContain("<!-- agent-teams-action:action-1 -->");
    expect(harness.dispatchBodies[0]).toContain("Agent: Review Agent");
    expect(harness.tokenBrokerCalls).toEqual([
      {
        capability: "github.issue_comment.request",
        targetId: "target-1",
      },
    ]);
    expect(harness.operations).toContain("content:shred");
    expect(harness.operations).toContain("request:succeeded");
    expect(harness.auditEvents).toContain("github_action.dispatch_started");
    expect(harness.auditEvents).toContain("github_action.dispatch_succeeded");
  });

  it("keeps worker events retryable while the feature gate is disabled", async () => {
    const harness = createHarness({ enabled: false });

    await expect(
      harness.useCase.execute({ actionRequestId: "action-1", attemptNumber: 1 }),
    ).resolves.toMatchObject({
      kind: "retry",
      safeError: { code: "CONTROL_PLANE_GITHUB_ACTIONS_WORKER_PAUSED" },
    });
    expect(harness.operations).toEqual([]);
  });

  it("preserves provider retry-after for outbox scheduling", async () => {
    const retryError = createSafeError({
      category: "external",
      code: "CONTROL_PLANE_GITHUB_ACTION_RATE_LIMITED",
      message: "rate limited",
      retryable: true,
    });
    const harness = createHarness({
      dispatcher: async () => ({
        kind: "failure",
        retryAfterMs: 120_000,
        safeError: retryError,
      }),
    });

    await expect(
      harness.useCase.execute({ actionRequestId: "action-1", attemptNumber: 3 }),
    ).resolves.toMatchObject({
      kind: "retry",
      retryAfterMs: 120_000,
    });
    expect(harness.operations).toContain("request:retryable-failure");
    expect(harness.operations).not.toContain("content:shred");
  });
});

function createHarness(
  input: {
    enabled?: boolean;
    dispatcher?: GitHubActionDispatcher["dispatch"];
  } = {},
) {
  const operations: string[] = [];
  const auditEvents: string[] = [];
  const dispatchBodies: string[] = [];
  const tokenBrokerCalls: Array<{ capability: string; targetId: string }> = [];
  const request = {
    actionType: "github.issue_comment.create" as const,
    assertedByDesktopClientId: "desktop-1" as never,
    attribution: {
      agentDisplayName: "Review Agent",
      teamId: "team:code",
    },
    createdAtMs: toUnixMilliseconds(0),
    externalContentIntegrityHash: "sha-1",
    externalContentRefId: "content-1" as never,
    id: "action-1" as never,
    idempotencyKey: "request-1",
    integrationTargetId: "target-1",
    requestedBySubjectId: "agent:reviewer",
    requestedBySubjectKind: "agent" as const,
    status: "queued" as const,
    updatedAtMs: toUnixMilliseconds(0),
    workspaceId: "workspace-1" as never,
  };
  const repository: GitHubActionRepository = {
    createQueued: async () => {
      throw new Error("unused");
    },
    findByIdempotency: async () => undefined,
    findForDispatch: async () => ({
      request,
      target: {
        displayFullName: "octo/repo",
        owner: "octo",
        repo: "repo",
        status: "enabled",
      },
    }),
    findStatus: async () => undefined,
    finishAttempt: async () => {
      operations.push("attempt:finished");
    },
    markDispatching: async () => {
      operations.push("request:dispatching");
    },
    markRetryableFailure: async () => {
      operations.push("request:retryable-failure");
    },
    markSucceeded: async () => {
      operations.push("request:succeeded");
    },
    markTerminalFailure: async () => {
      operations.push("request:terminal-failure");
    },
    recordAttemptStarted: async () => {
      operations.push("attempt:started");
    },
  };
  const contentStore: GitHubActionContentStore = {
    load: async () => ({
      plaintext: encodeGitHubActionPayloadEnvelope({
        actionType: "github.issue_comment.create",
        payload: {
          body: "Dispatch body",
          issueNumber: 7,
        },
      }),
    }),
    shred: async () => {
      operations.push("content:shred");
    },
    store: async () => {
      throw new Error("unused");
    },
  };
  const auditLog: AgentGitHubActionsAuditLog = {
    record: async (event) => {
      auditEvents.push(event.eventType);
    },
  };
  return {
    auditEvents,
    dispatchBodies,
    operations,
    tokenBrokerCalls,
    useCase: new DispatchGitHubActionUseCase(
      {
        assertEnabled: async () => undefined,
        isEnabled: () => input.enabled ?? true,
      },
      {
        agentAvatarAllowedOrigins: () => ["https://cdn.example.test"],
        defaultAgentAvatarUrl: () => "https://cdn.example.test/default.png",
        externalContentRetentionDays: () => 3,
        githubRestApiVersion: () => "2022-11-28",
      },
      repository,
      contentStore,
      {
        evaluate: async () => ({
          allowed: true,
          policyVersion: 1,
          reasonCode: "allowed",
        }),
      },
      {
        issue: async (brokerInput) => {
          tokenBrokerCalls.push({
            capability: brokerInput.capability,
            targetId: brokerInput.targetId,
          });
          return {
            expiresAtMs: 10_000,
            githubInstallationId: "installation-1",
            token: "server-only-token",
          };
        },
      },
      {
        dispatch: async (dispatchInput) => {
          if (dispatchInput.renderedBody !== undefined) {
            dispatchBodies.push(dispatchInput.renderedBody);
          }
          return input.dispatcher === undefined
            ? {
                githubDeliveryId: "comment-1",
                githubUrl: "https://github.com/octo/repo/issues/7#issuecomment-1",
                kind: "success",
              }
            : input.dispatcher(dispatchInput);
        },
      },
      { runInTransaction: async (work) => work({ transactionId: "tx" } as never) },
      auditLog,
      new FixedClock(1000),
    ),
  };
}
