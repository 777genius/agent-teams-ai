import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafeExecutionCommandRunner } from "@vioxen/subscription-runtime/worker-core";
import {
  DefaultWorkspaceSnapshotter,
  NodeSafeExecutionRuntime,
  NodeSafeExecutionWorkspaceAccess,
} from "../safe-execution";

describe("worker-local safe execution adapters", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  it("captures git snapshots through a command runner using only read-only commands", async () => {
    const workspacePath = await tempPath("safe-execution-adapter-git-");
    const commandRunner = new FakeGitCommandRunner((input) => {
      const args = input.args.join(" ");
      if (
        args === "rev-parse --is-inside-work-tree --show-prefix --show-toplevel"
      ) {
        return { stdout: `true\n\n${workspacePath}\n`, stderr: "" };
      }
      if (args === "status --porcelain=v1 -z --untracked-files=all -- .") {
        return { stdout: " M tracked.txt\0", stderr: "" };
      }
      if (args === "rev-parse HEAD^{tree}") {
        return { stdout: "tree-hash\n", stderr: "" };
      }
      if (args.includes("--name-only")) {
        return { stdout: "tracked.txt\n", stderr: "" };
      }
      if (args.includes("--stat")) {
        return { stdout: " tracked.txt | 1 +\n", stderr: "" };
      }
      if (args.includes("--numstat")) {
        return { stdout: "1\t0\ttracked.txt\n", stderr: "" };
      }
      if (args.startsWith("diff ")) {
        return {
          stdout: "diff --git a/tracked.txt b/tracked.txt\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected git command: ${args}`);
    });

    const snapshot = await new DefaultWorkspaceSnapshotter({
      commandRunner,
    }).capture({
      workspacePath,
      includeDiff: true,
    });

    expect(snapshot.changedFiles).toEqual(["tracked.txt"]);
    expect(snapshot.diffNumstat).toEqual([
      { path: "tracked.txt", additions: 2, deletions: 0 },
    ]);
    expect(commandRunner.commands()).toEqual([
      "rev-parse --is-inside-work-tree --show-prefix --show-toplevel",
      "status --porcelain=v1 -z --untracked-files=all -- .",
      "rev-parse HEAD^{tree}",
      "diff --relative --name-only --no-ext-diff -- .",
      "diff --relative --cached --name-only --no-ext-diff -- .",
      "diff --relative --stat --no-ext-diff -- .",
      "diff --relative --cached --stat --no-ext-diff -- .",
      "diff --relative --numstat --no-ext-diff -- .",
      "diff --relative --cached --numstat --no-ext-diff -- .",
      "diff --relative --no-ext-diff -- .",
      "diff --relative --cached --no-ext-diff -- .",
    ]);
    expect(commandRunner.commands().join("\n")).not.toMatch(
      /\b(reset|clean|checkout|apply|push)\b/,
    );
  });

  it("scopes git status entries to the requested workspace subdirectory", async () => {
    const repoPath = await tempPath("safe-execution-adapter-scope-");
    const workspacePath = join(repoPath, "app");
    await mkdir(workspacePath);
    const commandRunner = new FakeGitCommandRunner((input) => {
      const args = input.args.join(" ");
      if (
        args === "rev-parse --is-inside-work-tree --show-prefix --show-toplevel"
      ) {
        return { stdout: `true\napp/\n${repoPath}\n`, stderr: "" };
      }
      if (args === "status --porcelain=v1 -z --untracked-files=all -- .") {
        return {
          stdout: " M app/inside.txt\0 M other/outside.txt\0?? app/new.txt\0",
          stderr: "",
        };
      }
      if (args === "ls-tree HEAD -- app") {
        return {
          stdout: "040000 tree 0123456789012345678901234567890123456789\tapp\n",
          stderr: "",
        };
      }
      if (args.includes("--name-only")) {
        return { stdout: "inside.txt\nstaged.txt\n", stderr: "" };
      }
      if (args.includes("--stat")) {
        return { stdout: " inside.txt | 1 +\n staged.txt | 1 +\n", stderr: "" };
      }
      if (args.includes("--numstat")) {
        return { stdout: "1\t0\tinside.txt\n1\t0\tstaged.txt\n", stderr: "" };
      }
      if (args.startsWith("diff ")) {
        return { stdout: "diff --git a/inside.txt b/inside.txt\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${args}`);
    });

    const snapshot = await new DefaultWorkspaceSnapshotter({
      commandRunner,
    }).capture({
      workspacePath,
      includeDiff: true,
    });

    expect(snapshot.changedFiles).toEqual([
      "inside.txt",
      "new.txt",
      "staged.txt",
    ]);
    expect(snapshot.diffStat).toContain("inside.txt");
    expect(snapshot.diffStat).not.toContain("outside.txt");
    expect(snapshot.shortDiff).not.toContain("outside.txt");
  });

  it("checks git workspace access through the command port", async () => {
    const workspacePath = await tempPath("safe-execution-adapter-access-");
    const commandRunner = new FakeGitCommandRunner((input) => {
      if (input.args.join(" ") === "rev-parse --is-inside-work-tree") {
        return { stdout: "true\n", stderr: "" };
      }
      throw new Error("unexpected command");
    });
    const access = new NodeSafeExecutionWorkspaceAccess({ commandRunner });

    await expect(
      access.canonicalizePath({ path: workspacePath }),
    ).resolves.toBe(workspacePath);
    await expect(
      access.assertGitWorkspace({ workspacePath }),
    ).resolves.toBeUndefined();
    expect(commandRunner.commands()).toEqual([
      "rev-parse --is-inside-work-tree",
    ]);
  });

  it("exposes process identity through the runtime port", () => {
    const runtime = new NodeSafeExecutionRuntime();

    expect(runtime.createOwnerId()).toMatch(/^safe-execution:/);
    expect(runtime.currentPid()).toBe(process.pid);
  });

  async function tempPath(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    cleanupPaths.push(path);
    return path;
  }
});

class FakeGitCommandRunner implements SafeExecutionCommandRunner {
  private readonly calls: string[] = [];

  constructor(
    private readonly handler: (input: {
      readonly args: readonly string[];
      readonly cwd: string;
    }) => {
      readonly stdout: string;
      readonly stderr: string;
    },
  ) {}

  async run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }): Promise<{
    readonly stdout: string;
    readonly stderr: string;
  }> {
    this.calls.push(input.args.join(" "));
    return this.handler(input);
  }

  commands(): readonly string[] {
    return this.calls;
  }
}
