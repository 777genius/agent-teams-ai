import { describe, expect, it } from "vitest";
import { mapCodexGoalObservations } from "../application/codex-goal-bounded-map";
import { createCodexGoalObservationContext } from "../application/codex-goal-observation-context";

describe("Codex goal batch observation", () => {
  it("reads one process table and one workspace status per path", async () => {
    let processReads = 0;
    const workspaceReads = new Map<string, number>();
    const context = createCodexGoalObservationContext({
      async readProcessRows() {
        processReads += 1;
        return [
          { pid: 10, ppid: 1, cpu: 0, command: "node worker" },
          { pid: 11, ppid: 10, cpu: 25, command: "codex app-server --listen stdio://" },
        ];
      },
      async readWorkspaceStatus(path) {
        workspaceReads.set(path, (workspaceReads.get(path) ?? 0) + 1);
        return { exists: true, dirty: path.endsWith("dirty"), changedFiles: [] };
      },
    });

    const [root, child, firstWorkspace, repeatedWorkspace, secondWorkspace] =
      await Promise.all([
        context.processSnapshot(10),
        context.processSnapshot(11),
        context.workspaceStatus("/work/clean"),
        context.workspaceStatus("/work/clean"),
        context.workspaceStatus("/work/dirty"),
      ]);

    expect(processReads).toBe(1);
    expect(workspaceReads).toEqual(new Map([
      ["/work/clean", 1],
      ["/work/dirty", 1],
    ]));
    expect(root).toMatchObject({ alive: true, cpuActive: true, appServerAlive: true });
    expect(child).toMatchObject({ alive: true, cpuActive: true, appServerAlive: true });
    expect(firstWorkspace).toEqual(repeatedWorkspace);
    expect(secondWorkspace.dirty).toBe(true);
  });

  it("bounds observation fan-out and preserves input order", async () => {
    let active = 0;
    let maximumActive = 0;
    const values = Array.from({ length: 20 }, (_, index) => index);

    const results = await mapCodexGoalObservations(values, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      active -= 1;
      return value * 2;
    }, 3);

    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(results).toEqual(values.map((value) => value * 2));
  });

  it("does not retry a failed shared process-table read per job", async () => {
    let processReads = 0;
    const context = createCodexGoalObservationContext({
      async readProcessRows() {
        processReads += 1;
        throw new Error("process table unavailable");
      },
    });

    await expect(Promise.all([
      context.processSnapshot(10),
      context.processSnapshot(11),
      context.processSnapshot(12),
    ])).resolves.toEqual([{}, {}, {}]);
    expect(processReads).toBe(1);
  });
});
