import { describe, expect, it } from "vitest";
import {
  AgentProvider,
  QuotaLimitState,
  QuotaWindowKind,
} from "../../../domain/enums";
import { quotaSnapshotFromClaudeCodeStatusline } from "../ClaudeCodeStatuslineQuotaReader";

describe("quotaSnapshotFromClaudeCodeStatusline", () => {
  it("maps five-hour and weekly Claude Code statusline rate limits", () => {
    const snapshot = quotaSnapshotFromClaudeCodeStatusline({
      now: new Date("2026-07-09T10:00:00.000Z"),
      statuslineJson: {
        rate_limits: {
          five_hour: {
            used_percentage: 88,
            resets_at: 1783602000,
          },
          seven_day: {
            used_percentage: 100,
            resets_at: 1783861200,
          },
        },
      },
    });

    expect(snapshot).toMatchObject({
      provider: AgentProvider.ClaudeCode,
      windows: [
        {
          kind: QuotaWindowKind.FiveHour,
          usedPercent: 88,
          state: QuotaLimitState.Clear,
        },
        {
          kind: QuotaWindowKind.SevenDay,
          usedPercent: 100,
          state: QuotaLimitState.Limited,
        },
      ],
    });
  });

  it("returns null when Claude Code statusline has no rate limit data", () => {
    expect(
      quotaSnapshotFromClaudeCodeStatusline({
        now: new Date("2026-07-09T10:00:00.000Z"),
        statuslineJson: { model: { display_name: "Claude" } },
      }),
    ).toBeNull();
  });
});
