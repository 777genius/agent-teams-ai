import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const realpathMetrics = vi.hoisted(() => ({
  calls: 0,
  active: 0,
  maxActive: 0,
}));
const readdirMetrics = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (
      path: Parameters<typeof actual.readdir>[0],
      options: { readonly withFileTypes: true },
    ) => {
      const stringPath = String(path);
      if (stringPath.endsWith("/synthetic-package-limit")) {
        return Array.from({ length: 10_001 }, (_, index) => ({
          name: `package-${index}`,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }));
      }
      if (stringPath.includes("/synthetic-package-limit/package-")) return [];
      if (stringPath.endsWith("/synthetic-tree-limit/node_modules")) {
        return Array(250_001).fill({
          name: "file",
          isDirectory: () => false,
          isSymbolicLink: () => false,
        });
      }
      const measured =
        stringPath.split(/[\\/]/).at(-1)?.startsWith("parallel-directory-") ===
        true;
      if (measured) {
        readdirMetrics.active += 1;
        readdirMetrics.maxActive = Math.max(
          readdirMetrics.maxActive,
          readdirMetrics.active,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      try {
        return await actual.readdir(path, options);
      } finally {
        if (measured) readdirMetrics.active -= 1;
      }
    },
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      realpathMetrics.calls += 1;
      const measured = String(path).includes("parallel-target-");
      if (measured) {
        realpathMetrics.active += 1;
        realpathMetrics.maxActive = Math.max(
          realpathMetrics.maxActive,
          realpathMetrics.active,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      try {
        return await actual.realpath(path);
      } finally {
        if (measured) realpathMetrics.active -= 1;
      }
    },
  };
});

import {
  inspectNodeDependencyEnvironment,
  sanitizeNodeDependencyEnvironment,
} from "../dependency-environment-safety";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  resetRealpathMetrics();
  resetReaddirMetrics();
});

describe("node dependency environment safety", () => {
  it("caches a shared lexical target while preserving safe in-workspace links", async () => {
    const workspacePath = await createWorkspace();
    const dependencyRoot = join(workspacePath, "node_modules");
    await mkdir(join(dependencyRoot, ".pnpm", "shared"), {
      recursive: true,
    });
    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        symlink(
          ".pnpm/shared",
          join(dependencyRoot, `shared-package-${index}`),
          "dir",
        ),
      ),
    );
    resetRealpathMetrics();

    await expect(
      inspectNodeDependencyEnvironment({ workspacePath }),
    ).resolves.toEqual({
      dependencyRoots: ["node_modules"],
      unsafeDependencyRoots: [],
    });
    expect(realpathMetrics.calls).toBe(3);
  });

  it("accepts a relative symlink chain whose physical target stays in the workspace", async () => {
    const workspacePath = await createWorkspace();
    const dependencyRoot = join(workspacePath, "node_modules");
    const targetPath = join(dependencyRoot, ".pnpm", "safe-target");
    await mkdir(targetPath, { recursive: true });
    await symlink(
      ".pnpm/safe-hop",
      join(dependencyRoot, "safe-package"),
      "dir",
    );
    await symlink(
      "safe-target",
      join(dependencyRoot, ".pnpm", "safe-hop"),
      "dir",
    );

    await expect(
      inspectNodeDependencyEnvironment({ workspacePath }),
    ).resolves.toEqual({
      dependencyRoots: ["node_modules"],
      unsafeDependencyRoots: [],
    });
  });

  it("resolves distinct link targets concurrently with a strict upper bound", async () => {
    const workspacePath = await createWorkspace();
    const dependencyRoot = join(workspacePath, "node_modules");
    await mkdir(join(dependencyRoot, ".pnpm"), { recursive: true });
    await Promise.all(
      Array.from({ length: 96 }, async (_, index) => {
        const targetName = `parallel-target-${index}`;
        await mkdir(join(dependencyRoot, ".pnpm", targetName));
        await symlink(
          `.pnpm/${targetName}`,
          join(dependencyRoot, `package-${index}`),
          "dir",
        );
      }),
    );
    resetRealpathMetrics();

    const inspection = await inspectNodeDependencyEnvironment({
      workspacePath,
    });

    expect(inspection.unsafeDependencyRoots).toEqual([]);
    expect(realpathMetrics.maxActive).toBeGreaterThan(1);
    expect(realpathMetrics.maxActive).toBeLessThanOrEqual(32);
  });

  it("walks dependency directories concurrently with a strict upper bound", async () => {
    const workspacePath = await createWorkspace();
    const dependencyRoot = join(workspacePath, "node_modules");
    await mkdir(dependencyRoot);
    await Promise.all(
      Array.from({ length: 96 }, (_, index) =>
        mkdir(join(dependencyRoot, `parallel-directory-${index}`, "nested"), {
          recursive: true,
        }),
      ),
    );
    resetReaddirMetrics();

    await expect(
      inspectNodeDependencyEnvironment({ workspacePath }),
    ).resolves.toEqual({
      dependencyRoots: ["node_modules"],
      unsafeDependencyRoots: [],
    });
    expect(readdirMetrics.maxActive).toBeGreaterThan(1);
    expect(readdirMetrics.maxActive).toBeLessThanOrEqual(32);
  });

  it("discovers nested dependency roots concurrently with a strict upper bound", async () => {
    const workspacePath = await createWorkspace();
    await Promise.all(
      Array.from({ length: 96 }, (_, index) =>
        mkdir(
          join(
            workspacePath,
            `parallel-directory-package-${index}`,
            "node_modules",
          ),
          { recursive: true },
        ),
      ),
    );
    resetReaddirMetrics();

    const inspection = await inspectNodeDependencyEnvironment({
      workspacePath,
    });

    expect(inspection.dependencyRoots).toHaveLength(96);
    expect(inspection.unsafeDependencyRoots).toEqual([]);
    expect(readdirMetrics.maxActive).toBeGreaterThan(1);
    expect(readdirMetrics.maxActive).toBeLessThanOrEqual(32);
  });

  it("preserves the package discovery scan limit", async () => {
    const root = await createWorkspace();
    const workspacePath = join(root, "synthetic-package-limit");
    await mkdir(workspacePath);

    await expect(
      inspectNodeDependencyEnvironment({ workspacePath }),
    ).rejects.toThrow("dependency_environment_package_scan_limit_exceeded");
  });

  it("preserves the dependency entry scan limit", async () => {
    const root = await createWorkspace();
    const workspacePath = join(root, "synthetic-tree-limit");
    await mkdir(join(workspacePath, "node_modules"), { recursive: true });

    await expect(
      inspectNodeDependencyEnvironment({ workspacePath }),
    ).rejects.toThrow("dependency_environment_tree_scan_limit_exceeded");
  });

  it.each([
    "absolute escape",
    "relative escaping chain",
    "broken link",
  ] as const)("fails closed for an %s", async (scenario) => {
    const workspacePath = await createWorkspace();
    const dependencyRoot = join(workspacePath, "node_modules");
    const outsidePath = join(workspacePath, "..", "outside");
    await Promise.all([
      mkdir(dependencyRoot, { recursive: true }),
      mkdir(outsidePath, { recursive: true }),
    ]);

    if (scenario === "absolute escape") {
      await symlink(outsidePath, join(dependencyRoot, "unsafe"), "dir");
    } else if (scenario === "relative escaping chain") {
      await symlink("chain-hop", join(dependencyRoot, "unsafe"), "dir");
      await symlink("../../outside", join(dependencyRoot, "chain-hop"), "dir");
    } else {
      await symlink("missing-target", join(dependencyRoot, "unsafe"), "dir");
    }

    await expect(
      inspectNodeDependencyEnvironment({ workspacePath }),
    ).resolves.toEqual({
      dependencyRoots: ["node_modules"],
      unsafeDependencyRoots: ["node_modules"],
    });
  });

  it("rechecks and removes an unsafe dependency root during sanitization", async () => {
    const workspacePath = await createWorkspace();
    const dependencyRoot = join(workspacePath, "node_modules");
    const outsidePath = join(workspacePath, "..", "outside");
    await Promise.all([
      mkdir(dependencyRoot, { recursive: true }),
      mkdir(outsidePath, { recursive: true }),
    ]);
    await symlink(outsidePath, join(dependencyRoot, "unsafe"), "dir");

    await expect(
      sanitizeNodeDependencyEnvironment({ workspacePath }),
    ).resolves.toEqual({ removedPaths: ["node_modules"] });
    await expect(
      inspectNodeDependencyEnvironment({ workspacePath }),
    ).resolves.toEqual({ dependencyRoots: [], unsafeDependencyRoots: [] });
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "subscription-runtime-dependency-safety-"),
  );
  roots.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  return workspacePath;
}

function resetRealpathMetrics(): void {
  realpathMetrics.calls = 0;
  realpathMetrics.active = 0;
  realpathMetrics.maxActive = 0;
}

function resetReaddirMetrics(): void {
  readdirMetrics.active = 0;
  readdirMetrics.maxActive = 0;
}
