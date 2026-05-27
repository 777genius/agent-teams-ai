import { describe, expect, it } from "vitest";

import {
  bodyFromActionPayload,
  decodeGitHubActionPayload,
  renderGitHubActionBody,
  selectSafeAvatarUrl,
  validateAttributionRendererSettings,
  validateGitHubActionAttribution,
  validateGitHubActionPayload,
} from "./index.js";

describe("agent GitHub action domain", () => {
  it("renders mandatory attribution and idempotency marker with safe avatar fallback", () => {
    const body = renderGitHubActionBody({
      actionRequestId: "action-1",
      attribution: {
        agentAvatarUrl: "http://localhost/avatar.png",
        agentDisplayName: "Review Agent",
        teamDisplayName: "Code Team",
      },
      body: "Looks good.",
      settings: {
        allowedAvatarOrigins: ["https://cdn.example.test"],
        defaultAgentAvatarUrl: "https://cdn.example.test/default.png",
      },
    });

    expect(body).toContain("Looks good.");
    expect(body).toContain("<!-- agent-teams-action:action-1 -->");
    expect(body).toContain("Agent: Review Agent");
    expect(body).toContain("Team: Code Team");
    expect(body).toContain('src="https://cdn.example.test/default.png"');
  });

  it("uses an allowlisted HTTPS agent avatar", () => {
    expect(
      selectSafeAvatarUrl({
        agentAvatarUrl: "https://avatars.example.test/agent.png",
        settings: {
          allowedAvatarOrigins: ["https://avatars.example.test"],
          defaultAgentAvatarUrl: "https://avatars.example.test/default.png",
        },
      }),
    ).toBe("https://avatars.example.test/agent.png");
  });

  it("rejects multi-line attribution display names", () => {
    expect(
      validateGitHubActionAttribution({
        agentDisplayName: "Review Agent\nSpoofed Team",
      }),
    ).toMatchObject({
      code: "CONTROL_PLANE_GITHUB_ACTION_AGENT_NAME_INVALID",
    });
  });

  it("rejects unsafe default avatar settings", () => {
    expect(
      validateAttributionRendererSettings({
        allowedAvatarOrigins: ["https://cdn.example.test"],
        defaultAgentAvatarUrl: `https://cdn.example.test/${"a".repeat(2_100)}.png`,
      }),
    ).toMatchObject({
      code: "CONTROL_PLANE_GITHUB_ACTION_DEFAULT_AVATAR_UNSAFE",
    });
  });

  it("does not return unsafe default avatar URLs from the selector", () => {
    expect(() =>
      selectSafeAvatarUrl({
        settings: {
          allowedAvatarOrigins: ["https://cdn.example.test"],
          defaultAgentAvatarUrl: "https://evil.example.test/default.png",
        },
      }),
    ).toThrow("Default Agent Teams avatar URL is not safe.");
  });

  it("rejects unsupported pull request review events", () => {
    const payload = decodeGitHubActionPayload({
      actionType: "github.pull_request_review.create",
      payload: {
        body: "Please adjust",
        event: "REQUEST_CHANGES",
        pullRequestNumber: 42,
      },
    });

    expect(
      validateGitHubActionPayload({
        actionType: "github.pull_request_review.create",
        payload,
      }),
    ).toMatchObject({
      code: "CONTROL_PLANE_GITHUB_ACTION_REVIEW_EVENT_UNSUPPORTED",
    });
  });

  it("validates check run status and conclusion relationship", () => {
    const payload = decodeGitHubActionPayload({
      actionType: "github.check_run.create_or_update",
      payload: {
        conclusion: "success",
        headSha: "a".repeat(40),
        name: "Agent Teams / checks",
        status: "in_progress",
      },
    });

    expect(
      validateGitHubActionPayload({
        actionType: "github.check_run.create_or_update",
        payload,
      }),
    ).toMatchObject({
      code: "CONTROL_PLANE_GITHUB_ACTION_CHECK_CONCLUSION_INVALID",
    });
  });

  it("uses stable check run identity as fallback rendered body source", () => {
    expect(
      bodyFromActionPayload({
        headSha: "a".repeat(40),
        name: "Agent Teams / review",
        status: "queued",
      }),
    ).toBe("Agent Teams / review");
  });

  it("uses check run summary as attribution source when detailed text is present", () => {
    expect(
      bodyFromActionPayload({
        headSha: "a".repeat(40),
        name: "Agent Teams / review",
        status: "queued",
        summary: "Summary shown with attribution",
        text: "Detailed check output",
      }),
    ).toBe("Summary shown with attribution");
  });
});
