import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultDependencyCacheRoot,
  dependencyCacheNamespace,
  inspectDependencyBootstrap,
  runDependencyBootstrap,
} from "../dependency-bootstrap";

describe("dependency bootstrap", () => {
  it("detects pnpm without sharing node_modules", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-pnpm-");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({
        packageManager: "pnpm@9.15.0",
        scripts: {
          test: "vitest run",
          lint: "eslint .",
        },
      }));
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      const result = await inspectDependencyBootstrap(root);

      expect(result).toMatchObject({
        status: "deps_missing",
        nodeModulesExists: false,
        packageManager: {
          name: "pnpm",
          source: "packageManager",
          versionSpec: "pnpm@9.15.0",
          lockfilePath: join(root, "pnpm-lock.yaml"),
        },
      });
      expect(result.fingerprint).toHaveLength(64);
      expect(result.binaryChecks.map((check) => check.name)).toEqual([
        "eslint",
        "tsc",
        "vitest",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps per-worktree node_modules while using a package-manager cache command", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-install-");
    const jobRoot = join(root, "job");
    const workspace = join(root, "workspace");
    const cacheRoot = join(root, "cache");
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "package.json"), JSON.stringify({
        packageManager: "npm@11.0.0",
        scripts: { test: "vitest run" },
      }));
      await writeFile(join(workspace, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {},
      }));

      const result = await runDependencyBootstrap({
        workspacePath: workspace,
        jobRootDir: jobRoot,
        cacheRoot,
        mode: "install",
        confirmInstall: true,
        runCommand: async (command, args) => {
          expect([command, ...args]).toEqual([
            "npm",
            "ci",
            "--prefer-offline",
            "--cache",
            join(cacheRoot, "npm-cache"),
          ]);
          await mkdir(join(workspace, "node_modules", ".bin"), { recursive: true });
          await symlink(process.execPath, join(workspace, "node_modules", ".bin", "vitest"));
          await symlink(process.execPath, join(workspace, "node_modules", ".bin", "tsc"));
        },
      });

      expect(result).toMatchObject({
        status: "installed",
        nodeModulesPath: join(workspace, "node_modules"),
        cacheRoot,
        installCommand: `npm ci --prefer-offline --cache ${join(cacheRoot, "npm-cache")}`,
        diagnosticPath: join(jobRoot, "dependency-preflight.json"),
      });
      expect(result.nodeModulesPath.startsWith(cacheRoot)).toBe(false);
      const diagnostic = JSON.parse(
        await readFile(join(jobRoot, "dependency-preflight.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        status: "installed",
        nodeModulesPath: join(workspace, "node_modules"),
        cacheRoot,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before running dependency install", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-confirm-");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({
        packageManager: "npm@11.0.0",
      }));
      await writeFile(join(root, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {},
      }));

      const result = await runDependencyBootstrap({
        workspacePath: root,
        mode: "install",
      });

      expect(result).toMatchObject({
        mode: "install",
        status: "install_failed",
        warnings: expect.arrayContaining([
          "dependency_install_requires_confirmDependencyBootstrap",
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects and materializes a locked uv environment through the shared cache", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-uv-");
    const cacheRoot = join(root, "cache");
    try {
      await writeFile(join(root, "pyproject.toml"), "[project]\nname='fixture'\n");
      await writeFile(join(root, "uv.lock"), "version = 1\n");
      await writeFile(join(root, ".python-version"), "3.13\n");

      const result = await runDependencyBootstrap({
        workspacePath: root,
        cacheRoot,
        mode: "install",
        confirmInstall: true,
        runCommand: async (command, args) => {
          expect([command, ...args]).toEqual([
            "uv",
            "sync",
            "--locked",
            "--cache-dir",
            join(cacheRoot, "uv-cache"),
          ]);
          const bin = join(root, ".venv", "bin");
          await mkdir(bin, { recursive: true });
          for (const name of ["python", "pytest", "ruff"]) {
            await symlink(process.execPath, join(bin, name));
          }
        },
      });

      expect(result).toMatchObject({
        ecosystem: "python",
        status: "installed",
        environmentPath: join(root, ".venv"),
        environmentExists: true,
        packageManager: {
          name: "uv",
          source: "lockfile",
          lockfilePath: join(root, "uv.lock"),
        },
        cacheRoot,
      });
      expect(result.cacheLockPath).toContain(join(cacheRoot, ".locks"));
      expect(result.warnings).not.toContain("python_environment_missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("namespaces an operator-owned cache root without trusting project path text", () => {
    const previous = process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT;
    process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT = "/var/cache/agents";
    try {
      const namespace = dependencyCacheNamespace("777genius/infinity-context");
      expect(namespace).toMatch(/^777genius-infinity-context-[a-f0-9]{12}$/);
      expect(defaultDependencyCacheRoot({
        workspacePath: "/tmp/workspace",
        cacheNamespace: "777genius/infinity-context",
      })).toBe(join("/var/cache/agents", namespace));
    } finally {
      if (previous === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT = previous;
      }
    }
  });

  it("rejects a relative operator-owned cache root", () => {
    const previous = process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT;
    process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT = "relative/cache";
    try {
      expect(() => defaultDependencyCacheRoot({
        workspacePath: "/tmp/workspace",
      })).toThrowError("dependency_cache_root_must_be_absolute");
    } finally {
      if (previous === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT = previous;
      }
    }
  });

  it("rejects a relative explicit cache root", () => {
    expect(() => defaultDependencyCacheRoot({
      workspacePath: "/tmp/workspace",
      cacheRoot: "relative/cache",
    })).toThrowError("dependency_cache_root_must_be_absolute");
  });

  it("fails before installation when the explicit cache root is relative", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-relative-cache-");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({}));
      await writeFile(join(root, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {},
      }));

      await expect(runDependencyBootstrap({
        workspacePath: root,
        cacheRoot: "relative/cache",
        mode: "install",
        confirmInstall: true,
        runCommand: async () => {
          throw new Error("install must not run");
        },
      })).rejects.toThrowError("dependency_cache_root_must_be_absolute");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not allow a Node packageManager field to select the Python adapter", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-node-manager-");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({
        packageManager: "uv@0.8.0",
      }));
      await writeFile(join(root, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {},
      }));

      const result = await inspectDependencyBootstrap(root);

      expect(result).toMatchObject({
        ecosystem: "node",
        packageManager: { name: "npm", source: "lockfile" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function mkTestWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
