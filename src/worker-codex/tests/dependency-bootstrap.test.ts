import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
});

async function mkTestWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
