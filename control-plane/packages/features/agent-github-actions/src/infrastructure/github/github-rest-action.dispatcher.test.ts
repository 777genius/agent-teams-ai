import { describe, expect, it } from "vitest";

import { GitHubRestActionDispatcher } from "./github-rest-action.dispatcher.js";

describe("GitHubRestActionDispatcher", () => {
  it("creates issue comments with pinned GitHub API headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const dispatcher = new GitHubRestActionDispatcher(settings(), async (url, init) => {
      calls.push({ init: init ?? {}, url: String(url) });
      return new Response(
        JSON.stringify({
          html_url: "https://github.com/octo/repo/issues/7#issuecomment-1",
          id: 123,
        }),
        {
          headers: { "x-github-request-id": "request-1" },
          status: 201,
        },
      );
    });

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.issue_comment.create",
        payload: { body: "raw", issueNumber: 7 },
        renderedBody: "rendered body",
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      githubDeliveryId: "123",
      githubRequestId: "request-1",
      githubStatusCode: 201,
      githubUrl: "https://github.com/octo/repo/issues/7#issuecomment-1",
      kind: "success",
    });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/octo/repo/issues/7/comments",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ body: "rendered body" });
  });

  it("maps GitHub retry-after responses to retryable safe failures", async () => {
    const dispatcher = new GitHubRestActionDispatcher(
      settings(),
      async () =>
        new Response(JSON.stringify({ message: "secondary rate limit" }), {
          headers: {
            "retry-after": "120",
            "x-github-request-id": "request-2",
          },
          status: 403,
        }),
    );

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.issue_comment.create",
        payload: { body: "raw", issueNumber: 7 },
        renderedBody: "rendered body",
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      kind: "failure",
      retryAfterMs: 120_000,
      safeError: {
        code: "CONTROL_PLANE_GITHUB_ACTION_RATE_LIMITED",
        retryable: true,
      },
    });
  });

  it("does not allow zero-delay rate limit retries", async () => {
    const dispatcher = new GitHubRestActionDispatcher(
      settings(),
      async () =>
        new Response(JSON.stringify({ message: "secondary rate limit" }), {
          headers: {
            "retry-after": "0",
            "x-github-request-id": "request-2",
          },
          status: 403,
        }),
    );

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.issue_comment.create",
        payload: { body: "raw", issueNumber: 7 },
        renderedBody: "rendered body",
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      kind: "failure",
      retryAfterMs: 60_000,
      safeError: {
        code: "CONTROL_PLANE_GITHUB_ACTION_RATE_LIMITED",
        retryable: true,
      },
    });
  });

  it("sends rendered attribution in check run output without unique names", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const dispatcher = new GitHubRestActionDispatcher(settings(), async (url, init) => {
      calls.push({ init: init ?? {}, url: String(url) });
      return new Response(
        JSON.stringify({ html_url: "https://github.com/octo/repo/runs/9", id: 9 }),
        {
          status: 201,
        },
      );
    });

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.check_run.create_or_update",
        payload: {
          headSha: "a".repeat(40),
          name: "Agent Teams / review",
          status: "queued",
        },
        renderedBody: "Agent Teams / review\n\nAgent: Review Agent",
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      githubCheckRunId: "9",
      kind: "success",
    });

    expect(calls[0]?.url).toBe("https://api.github.com/repos/octo/repo/check-runs");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      external_id: "action-1",
      head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Agent Teams / review",
      output: {
        summary: "Agent Teams / review\n\nAgent: Review Agent",
        title: "Agent Teams / review",
      },
      status: "queued",
    });
  });

  it("preserves optional check run output text separately from rendered summary", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const dispatcher = new GitHubRestActionDispatcher(settings(), async (url, init) => {
      calls.push({ init: init ?? {}, url: String(url) });
      return new Response(JSON.stringify({ id: 9 }), {
        status: 201,
      });
    });

    await dispatcher.dispatch({
      actionRequestId: "action-1",
      actionType: "github.check_run.create_or_update",
      payload: {
        headSha: "a".repeat(40),
        name: "Agent Teams / review",
        status: "queued",
        text: "Detailed check output",
      },
      renderedBody: "Summary with attribution",
      target: { owner: "octo", repo: "repo" },
      tokenLease: {
        expiresAtMs: 1000,
        githubInstallationId: "installation-1",
        token: "secret-token",
      },
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      output: {
        summary: "Summary with attribution",
        text: "Detailed check output",
        title: "Agent Teams / review",
      },
    });
  });

  it("rejects check run dispatch without rendered attribution", async () => {
    const dispatcher = new GitHubRestActionDispatcher(settings(), async () => {
      throw new Error("fetch must not be called");
    });

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.check_run.create_or_update",
        payload: {
          headSha: "a".repeat(40),
          name: "Agent Teams / review",
          status: "queued",
        },
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      kind: "failure",
      safeError: {
        code: "CONTROL_PLANE_GITHUB_ACTION_RENDERED_BODY_REQUIRED",
      },
    });
  });

  it("updates check runs by stored id without create-only head sha", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const dispatcher = new GitHubRestActionDispatcher(settings(), async (url, init) => {
      calls.push({ init: init ?? {}, url: String(url) });
      return new Response(
        JSON.stringify({ html_url: "https://github.com/octo/repo/runs/9", id: 9 }),
        {
          status: 200,
        },
      );
    });

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.check_run.create_or_update",
        checkRunId: "9",
        payload: {
          conclusion: "success",
          headSha: "a".repeat(40),
          name: "Agent Teams / review",
          status: "completed",
        },
        renderedBody: "Agent Teams / review\n\nAgent: Review Agent",
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      githubCheckRunId: "9",
      kind: "success",
    });

    expect(calls[0]?.url).toBe("https://api.github.com/repos/octo/repo/check-runs/9");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      conclusion: "success",
      external_id: "action-1",
      name: "Agent Teams / review",
      output: {
        summary: "Agent Teams / review\n\nAgent: Review Agent",
        title: "Agent Teams / review",
      },
      status: "completed",
    });
  });

  it("dead-letters unknown check run create results to avoid duplicates", async () => {
    const dispatcher = new GitHubRestActionDispatcher(settings(), async () => {
      throw new Error("network reset");
    });

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.check_run.create_or_update",
        payload: {
          headSha: "a".repeat(40),
          name: "Agent Teams / review",
          status: "queued",
        },
        renderedBody: "Agent Teams / review\n\nAgent: Review Agent",
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      kind: "failure",
      safeError: {
        code: "CONTROL_PLANE_GITHUB_ACTION_UNKNOWN_RESULT",
        retryable: false,
      },
    });
  });

  it("retries unknown check run updates when stored check run id is present", async () => {
    const dispatcher = new GitHubRestActionDispatcher(settings(), async () => {
      throw new Error("network reset");
    });

    await expect(
      dispatcher.dispatch({
        actionRequestId: "action-1",
        actionType: "github.check_run.create_or_update",
        checkRunId: "9",
        payload: {
          headSha: "a".repeat(40),
          name: "Agent Teams / review",
          status: "in_progress",
        },
        renderedBody: "Agent Teams / review\n\nAgent: Review Agent",
        target: { owner: "octo", repo: "repo" },
        tokenLease: {
          expiresAtMs: 1000,
          githubInstallationId: "installation-1",
          token: "secret-token",
        },
      }),
    ).resolves.toMatchObject({
      kind: "failure",
      safeError: {
        code: "CONTROL_PLANE_GITHUB_ACTION_TRANSPORT_FAILED",
        retryable: true,
      },
    });
  });
});

function settings() {
  return {
    agentAvatarAllowedOrigins: () => [],
    defaultAgentAvatarUrl: () => undefined,
    externalContentRetentionDays: () => undefined,
    githubRestApiVersion: () => "2022-11-28",
  };
}
