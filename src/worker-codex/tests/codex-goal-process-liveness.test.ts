import { describe, expect, it, vi } from "vitest";
import {
  RunProcessAliveReason,
  RunProcessSupervisorKind,
} from "@vioxen/subscription-runtime/worker-core";
import {
  resolveCodexGoalWorkerLiveness,
  stopCodexGoalDirectProcess,
} from "../application/codex-goal-process-liveness";

describe("codex goal process liveness", () => {
  it("does not treat stopped progress as a live worker", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        progressExists: true,
        progressStatus: "stopped",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
        progressCommand: "node subscription-runtime-codex-goal run",
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.TerminalResult,
    });
  });

  it("never signals a legacy control-plane pid stored in stopped progress", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      expect(stopCodexGoalDirectProcess({
        progressStatus: "stopped",
        progressPid: process.pid,
        progressProcessAlive: true,
        progressCommand: "node subscription-runtime-codex-goal-mcp",
      })).toEqual({
        preview: "terminal progress has no stoppable worker process",
        status: "process_gone",
        pid: process.pid,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
