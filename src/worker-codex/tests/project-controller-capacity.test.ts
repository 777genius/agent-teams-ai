import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  isProjectControllerQuotaFailure,
  isProjectControllerSessionInvalidFailure,
  projectControllerCapacityDemand,
  recordProjectControllerCapacitySignal,
} from "../project-controller-capacity";

describe("project controller capacity signals", () => {
  it("records quota-limited controller failures as account cooldowns", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-capacity-"));
    try {
      const recorded = recordProjectControllerCapacitySignal({
        stateRootDir: root,
        controllerJobId: "infinity-context-project-controller-v1",
        config: {
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
          quotaCooldownMs: 60_000,
        },
        run: {
          status: "failed",
          safeMessage: "Codex quota or billing limit was reached.",
          capacityAccountId: "account-d",
        },
        observedAt: new Date("2026-07-05T11:00:00.000Z"),
      });

      expect(recorded).toBe(true);
      const capacity = new LocalFileWorkerAccountCapacityStore({
        rootDir: join(root, "worker-account-capacity"),
      }).read({
        accountId: "account-d",
        demand: projectControllerCapacityDemand({
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
        }),
        now: new Date("2026-07-05T11:00:01.000Z"),
      });
      expect(capacity).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });
      expect(capacity?.cooldownUntil?.toISOString()).toBe(
        "2026-07-05T11:01:00.000Z",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records invalid controller sessions as reconnect cooldowns", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-capacity-"));
    try {
      const recorded = recordProjectControllerCapacitySignal({
        stateRootDir: root,
        controllerJobId: "infinity-context-project-controller-v1",
        config: {
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
          reconnectCooldownMs: 90_000,
        },
        run: {
          status: "failed",
          safeMessage: "Codex session is invalid.",
          capacityAccountId: "account-d",
        },
        observedAt: new Date("2026-07-05T11:00:00.000Z"),
      });

      const capacity = new LocalFileWorkerAccountCapacityStore({
        rootDir: join(root, "worker-account-capacity"),
      }).read({
        accountId: "account-d",
        demand: projectControllerCapacityDemand({
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "fast",
        }),
        now: new Date("2026-07-05T11:00:01.000Z"),
      });
      expect(recorded).toBe(true);
      expect(capacity).toMatchObject({
        availability: "cooldown",
        reason: "provider_session_invalid",
      });
      expect(capacity?.cooldownUntil?.toISOString()).toBe(
        "2026-07-05T11:01:30.000Z",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores generic controller failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-capacity-"));
    try {
      const recorded = recordProjectControllerCapacitySignal({
        stateRootDir: root,
        controllerJobId: "infinity-context-project-controller-v1",
        config: { model: "gpt-5.5" },
        run: {
          status: "failed",
          safeMessage: "provider process exited",
          capacityAccountId: "account-d",
        },
        observedAt: new Date("2026-07-05T11:00:00.000Z"),
      });

      expect(recorded).toBe(false);
      const capacity = new LocalFileWorkerAccountCapacityStore({
        rootDir: join(root, "worker-account-capacity"),
      }).read({
        accountId: "account-d",
        now: new Date("2026-07-05T11:00:01.000Z"),
      });
      expect(capacity).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies billing, quota and usage-limit messages only", () => {
    expect(isProjectControllerQuotaFailure("billing limit reached")).toBe(true);
    expect(isProjectControllerQuotaFailure("rate limit exceeded")).toBe(true);
    expect(isProjectControllerQuotaFailure("usage limit reached")).toBe(true);
    expect(isProjectControllerQuotaFailure("session is invalid")).toBe(false);
  });

  it("classifies invalid session controller messages only", () => {
    expect(isProjectControllerSessionInvalidFailure("Codex session is invalid.")).toBe(
      true,
    );
    expect(
      isProjectControllerSessionInvalidFailure(
        "Provider account session is unavailable.",
      ),
    ).toBe(true);
    expect(isProjectControllerSessionInvalidFailure("quota limited")).toBe(false);
  });
});
