import { describe, expect, it } from "vitest";
import {
  ControllerSupervisorObservedStatus,
  controllerSupervisorDeliverableGuidanceSignature,
  controllerSupervisorHasDeliverableGuidance,
  controllerSupervisorHasAvailableAccounts,
  controllerSupervisorJobArgs,
  controllerSupervisorNextCapacityRetryDelayMs,
  controllerSupervisorObservedStatus,
  controllerSupervisorStatusIsTerminal,
  controllerSupervisorStatusRequiresControlDecision,
  controllerSupervisorTerminalStatusCanRetry,
} from "../codex-goal-mcp-client";

describe("codex goal MCP client supervisor helpers", () => {
  it("reads nested provider status before persisted run status", () => {
    expect(controllerSupervisorObservedStatus({
      ok: true,
      mode: "project_controller_status",
      run: { status: "running" },
      providerObserved: { status: "completed" },
      liveController: { providerObservedStatus: "completed" },
    })).toBe(ControllerSupervisorObservedStatus.Completed);
  });

  it("falls back through live controller, run, session and top-level status", () => {
    expect(controllerSupervisorObservedStatus({
      liveController: { providerObservedStatus: "blocked" },
      run: { status: "running" },
    })).toBe(ControllerSupervisorObservedStatus.Blocked);
    expect(controllerSupervisorObservedStatus({
      run: { status: "failed" },
      session: { status: "running" },
    })).toBe(ControllerSupervisorObservedStatus.Failed);
    expect(controllerSupervisorObservedStatus({
      session: { status: "stale" },
    })).toBe(ControllerSupervisorObservedStatus.Stale);
    expect(controllerSupervisorObservedStatus({
      status: "running",
    })).toBe(ControllerSupervisorObservedStatus.Running);
  });

  it("treats only planned and running as non-terminal", () => {
    expect(controllerSupervisorStatusIsTerminal(
      ControllerSupervisorObservedStatus.Planned,
    )).toBe(false);
    expect(controllerSupervisorStatusIsTerminal(
      ControllerSupervisorObservedStatus.Running,
    )).toBe(false);
    expect(controllerSupervisorStatusIsTerminal(
      ControllerSupervisorObservedStatus.Completed,
    )).toBe(true);
    expect(controllerSupervisorStatusIsTerminal(
      ControllerSupervisorObservedStatus.Failed,
    )).toBe(true);
  });

  it("requests control decisions only for blocked project controllers", () => {
    expect(controllerSupervisorStatusRequiresControlDecision(
      ControllerSupervisorObservedStatus.Blocked,
    )).toBe(true);
    expect(controllerSupervisorStatusRequiresControlDecision(
      ControllerSupervisorObservedStatus.Failed,
    )).toBe(false);
    expect(controllerSupervisorStatusRequiresControlDecision(
      ControllerSupervisorObservedStatus.Completed,
    )).toBe(false);
    expect(controllerSupervisorStatusRequiresControlDecision(
      ControllerSupervisorObservedStatus.Running,
    )).toBe(false);
  });

  it("retries failed project controllers only after quota failures", () => {
    expect(controllerSupervisorTerminalStatusCanRetry(
      ControllerSupervisorObservedStatus.Failed,
      { ok: true, run: { safeMessage: "Codex quota or billing limit was reached." } },
    )).toBe(true);
    expect(controllerSupervisorTerminalStatusCanRetry(
      ControllerSupervisorObservedStatus.Failed,
      { ok: true, run: { safeMessage: "Codex task timed out." } },
    )).toBe(true);
    expect(controllerSupervisorTerminalStatusCanRetry(
      ControllerSupervisorObservedStatus.Failed,
      { ok: true, run: { safeMessage: "Codex session is invalid." } },
    )).toBe(false);
    expect(controllerSupervisorTerminalStatusCanRetry(
      ControllerSupervisorObservedStatus.Blocked,
      { ok: true, run: { safeMessage: "Codex quota or billing limit was reached." } },
    )).toBe(false);
  });

  it("retries blocked project controllers only when guidance is deliverable", () => {
    expect(controllerSupervisorTerminalStatusCanRetry(
      ControllerSupervisorObservedStatus.Blocked,
      { ok: true, run: { safeMessage: "Codex controlled-agent is waiting for input." } },
      { ok: true, decision: { deliverableCount: 1 } },
    )).toBe(true);
    expect(controllerSupervisorTerminalStatusCanRetry(
      ControllerSupervisorObservedStatus.Blocked,
      { ok: true, run: { safeMessage: "Codex controlled-agent is waiting for input." } },
      { ok: true, decision: { pendingCount: 3, deliverableCount: 0 } },
    )).toBe(false);
  });

  it("recognizes read-only control decisions with deliverable guidance", () => {
    expect(controllerSupervisorHasDeliverableGuidance({
      ok: true,
      decision: { deliverableCount: 2 },
    })).toBe(true);
    expect(controllerSupervisorHasDeliverableGuidance({
      ok: true,
      decision: { deliverableSignals: [{ id: "signal-a" }] },
    })).toBe(true);
    expect(controllerSupervisorHasDeliverableGuidance({
      ok: true,
      decision: { pendingCount: 3, deliverableCount: 0 },
    })).toBe(false);
    expect(controllerSupervisorHasDeliverableGuidance({ ok: false })).toBe(false);
  });

  it("builds stable deliverable guidance signatures from signal ids", () => {
    expect(controllerSupervisorDeliverableGuidanceSignature({
      ok: true,
      decision: {
        deliverableSignals: [
          { signal: { signalId: "signal-a" } },
          { signalId: "signal-b" },
        ],
      },
    })).toBe("signal-a,signal-b");
    expect(controllerSupervisorDeliverableGuidanceSignature({
      ok: true,
      decision: { deliverableCount: 2 },
    })).toBe("count:2");
    expect(controllerSupervisorDeliverableGuidanceSignature({
      ok: true,
      decision: { deliverableCount: 0 },
    })).toBeUndefined();
  });

  it("continues only while project accounts remain available", () => {
    expect(controllerSupervisorHasAvailableAccounts({
      ok: true,
      summary: { availableDeduped: 1 },
    })).toBe(true);
    expect(controllerSupervisorHasAvailableAccounts({
      ok: true,
      available: 1,
    })).toBe(true);
    expect(controllerSupervisorHasAvailableAccounts({
      ok: true,
      summary: { availableDeduped: 0 },
    })).toBe(false);
    expect(controllerSupervisorHasAvailableAccounts({ ok: false })).toBe(false);
  });

  it("checks controller account capacity through the controller job id", () => {
    expect(controllerSupervisorJobArgs({
      controllerJobId: "infinity-context-project-controller-v1",
      registryRootDir: "/var/data/infinity-context/worker-jobs/registry",
    })).toEqual({
      controllerJobId: "infinity-context-project-controller-v1",
      jobId: "infinity-context-project-controller-v1",
      registryRootDir: "/var/data/infinity-context/worker-jobs/registry",
    });
  });

  it("waits for the nearest account cooldown instead of exiting", () => {
    expect(controllerSupervisorNextCapacityRetryDelayMs({
      ok: true,
      accounts: [
        { name: "account-a", capacityCooldownUntil: "2026-07-06T01:40:00.000Z" },
        { name: "account-b", capacityCooldownUntil: "2026-07-06T01:35:00.000Z" },
      ],
    }, Date.parse("2026-07-06T01:30:00.000Z"))).toBe(5 * 60_000);

    expect(controllerSupervisorNextCapacityRetryDelayMs({
      ok: true,
      accounts: [
        { name: "account-a", capacityCooldownUntil: "2026-07-06T01:20:00.000Z" },
      ],
    }, Date.parse("2026-07-06T01:30:00.000Z"))).toBeUndefined();
  });
});
