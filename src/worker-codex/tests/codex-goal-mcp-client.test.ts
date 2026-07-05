import { describe, expect, it } from "vitest";
import {
  ControllerSupervisorObservedStatus,
  controllerSupervisorObservedStatus,
  controllerSupervisorStatusIsTerminal,
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
});
