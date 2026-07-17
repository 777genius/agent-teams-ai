import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  defaultDependencyCacheRoot,
  dependencyCacheNamespace,
  inspectDependencyBootstrap,
  runDependencyBootstrap,
} from "../dependency-bootstrap";
import { assertProjectControlDependencyBootstrapReady } from "../codex-goal-mcp-project-scope";

const execFileAsync = promisify(execFile);

describe("dependency bootstrap", () => {
  it("detects pnpm without sharing node_modules", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-pnpm-");
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@9.15.0",
          scripts: {
            test: "vitest run",
            lint: "eslint .",
          },
        }),
      );
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
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({
          packageManager: "npm@11.0.0",
          scripts: { test: "vitest run" },
        }),
      );
      await writeFile(
        join(workspace, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {},
        }),
      );

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
          await mkdir(join(workspace, "node_modules", ".bin"), {
            recursive: true,
          });
          await writeFile(
            join(workspace, "node_modules", ".bin", "vitest"),
            "",
          );
          await writeFile(join(workspace, "node_modules", ".bin", "tsc"), "");
        },
      });

      expect(result).toMatchObject({
        status: "installed",
        nodeModulesPath: join(await realpath(workspace), "node_modules"),
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
        nodeModulesPath: join(await realpath(workspace), "node_modules"),
        cacheRoot,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds install execution to the canonical workspace when an alias is retargeted", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-deps-retarget-"));
    const workspace = join(root, "inside");
    const alias = join(root, "workspace-alias");
    const outside = join(root, "outside");
    try {
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(join(outside, "node_modules"), { recursive: true }),
      ]);
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({ packageManager: "npm@11.0.0" }),
      );
      await writeFile(
        join(workspace, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages: {} }),
      );
      await symlink(workspace, alias, "dir");
      const canonicalWorkspace = await realpath(workspace);
      const result = await runDependencyBootstrap({
        workspacePath: alias,
        cacheRoot: join(root, "cache"),
        mode: "install",
        confirmInstall: true,
        runCommand: async (_command, _args, options) => {
          await rm(alias);
          await symlink(outside, alias, "dir");
          expect(options.cwd).toBe(canonicalWorkspace);
          await mkdir(join(options.cwd, "node_modules", ".bin"), {
            recursive: true,
          });
        },
      });

      expect(result.status).toBe("installed");
      await expect(access(join(outside, "node_modules"))).resolves.toBeUndefined();
      await expect(access(join(workspace, "node_modules"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on cross-worktree dependency links and sanitizes before install", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-unsafe-");
    const workspace = join(root, "workspace");
    const foreign = join(root, "other-worktree", "node_modules", ".pnpm");
    try {
      await Promise.all([
        mkdir(join(workspace, "node_modules"), { recursive: true }),
        mkdir(join(workspace, "meta"), { recursive: true }),
        mkdir(foreign, { recursive: true }),
      ]);
      await writeFile(
        join(workspace, "meta", "package.json"),
        JSON.stringify({
          packageManager: "npm@11.0.0",
        }),
      );
      await symlink("meta/package.json", join(workspace, "package.json"));
      await writeFile(
        join(workspace, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {},
        }),
      );
      await symlink(foreign, join(workspace, "node_modules", ".pnpm"));

      const unsafe = await inspectDependencyBootstrap(workspace, "off");
      expect(unsafe).toMatchObject({
        status: "unsafe",
        unsafeDependencyPaths: ["node_modules"],
      });
      expect(() =>
        assertProjectControlDependencyBootstrapReady(unsafe),
      ).toThrow("project_control_dependency_environment_unsafe:node_modules");
      const result = await runDependencyBootstrap({
        workspacePath: workspace,
        mode: "install",
        confirmInstall: true,
        runCommand: async () => {
          await expect(
            access(join(workspace, "node_modules")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await mkdir(join(workspace, "node_modules", ".bin"), {
            recursive: true,
          });
          await writeFile(join(workspace, "node_modules", ".bin", "tsc"), "");
        },
      });

      expect(result).toMatchObject({
        status: "installed",
        sanitizedDependencyPaths: ["node_modules"],
      });
      expect(result.unsafeDependencyPaths).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts dependency links that stay inside the isolated workspace", async () => {
    const root = await mkTestWorkspace(
      "subscription-runtime-deps-local-links-",
    );
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@9.15.0",
        }),
      );
      const packageTarget = join(
        root,
        "node_modules",
        ".pnpm",
        "fixture@1.0.0",
        "node_modules",
        "fixture",
      );
      await mkdir(packageTarget, { recursive: true });
      await symlink(
        ".pnpm/fixture@1.0.0/node_modules/fixture",
        join(root, "node_modules", "fixture"),
      );

      const result = await inspectDependencyBootstrap(root);
      expect(result).toMatchObject({ status: "ready" });
      expect(result.unsafeDependencyPaths).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before running dependency install", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-confirm-");
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "npm@11.0.0",
        }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {},
        }),
      );

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

  it("restores pre-existing staged and dirty state after a failed tracked mutation", async () => {
    const root = await mkGitDependencyWorkspace(
      "subscription-runtime-deps-transaction-tracked-",
      "pnpm",
    );
    try {
      const packageJsonPath = join(root, "package.json");
      const workspaceManifestPath = join(root, "pnpm-workspace.yaml");
      await writeFile(
        packageJsonPath,
        JSON.stringify({ packageManager: "pnpm@9.15.0", staged: true }),
      );
      await git(root, ["add", "package.json"]);
      await writeFile(
        packageJsonPath,
        JSON.stringify({
          packageManager: "pnpm@9.15.0",
          staged: true,
          dirty: true,
        }),
      );
      const [statusBefore, stagedBefore, packageJsonBefore] = await Promise.all([
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        git(root, ["diff", "--cached", "--binary", "HEAD", "--"]),
        readFile(packageJsonPath),
      ]);

      const result = await runDependencyBootstrap({
        workspacePath: root,
        mode: "install",
        confirmInstall: true,
        runCommand: async () => {
          await writeFile(workspaceManifestPath, "packages:\n  - generated/*\n");
          throw new Error("simulated_install_failure");
        },
      });

      expect(result.status).toBe("install_failed");
      expect(result.warnings).toContain(
        "dependency_install_failed:simulated_install_failure",
      );
      await expect(readFile(workspaceManifestPath, "utf8")).resolves.toBe(
        "packages:\n  - packages/*\n",
      );
      await expect(readFile(packageJsonPath)).resolves.toEqual(packageJsonBefore);
      await expect(
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      ).resolves.toEqual(statusBefore);
      await expect(
        git(root, ["diff", "--cached", "--binary", "HEAD", "--"]),
      ).resolves.toEqual(stagedBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores pre-existing and bootstrap-created untracked files after failure", async () => {
    const root = await mkGitDependencyWorkspace(
      "subscription-runtime-deps-transaction-untracked-",
      "npm",
    );
    const existingUntrackedPath = join(root, "operator-notes.txt");
    const generatedPath = join(root, "bootstrap-generated.yaml");
    try {
      await writeFile(existingUntrackedPath, "keep exactly\n");
      const statusBefore = await git(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);

      const result = await runDependencyBootstrap({
        workspacePath: root,
        mode: "install",
        confirmInstall: true,
        runCommand: async () => {
          await writeFile(existingUntrackedPath, "bootstrap changed this\n");
          await writeFile(generatedPath, "generated: true\n");
          throw new Error("simulated_install_failure");
        },
      });

      expect(result.status).toBe("install_failed");
      await expect(readFile(existingUntrackedPath, "utf8")).resolves.toBe(
        "keep exactly\n",
      );
      await expect(access(generatedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      ).resolves.toEqual(statusBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects and rolls back a successful install that mutates source state", async () => {
    const root = await mkGitDependencyWorkspace(
      "subscription-runtime-deps-transaction-success-mutation-",
      "npm",
    );
    const sourcePath = join(root, "README.md");
    try {
      const result = await runDependencyBootstrap({
        workspacePath: root,
        mode: "install",
        confirmInstall: true,
        runCommand: async () => {
          await writeFile(sourcePath, "changed by bootstrap\n");
          await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
          await writeFile(join(root, "node_modules", ".bin", "tsc"), "");
        },
      });

      expect(result.status).toBe("install_failed");
      expect(
        result.warnings.some(
          (warning) =>
            warning.includes(
              "dependency_bootstrap_workspace_mutation_detected:",
            ) && warning.includes("README.md"),
        ),
      ).toBe(true);
      await expect(readFile(sourcePath, "utf8")).resolves.toBe("fixture\n");
      await expect(access(join(root, "node_modules"))).resolves.toBeUndefined();
      await expect(git(root, ["status", "--porcelain=v1"])).resolves.toEqual(
        Buffer.alloc(0),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a successful install that changes only ignored dependency artifacts", async () => {
    const root = await mkGitDependencyWorkspace(
      "subscription-runtime-deps-transaction-success-",
      "npm",
    );
    try {
      const result = await runDependencyBootstrap({
        workspacePath: root,
        mode: "install",
        confirmInstall: true,
        runCommand: async () => {
          const binPath = join(root, "node_modules", ".bin");
          await mkdir(binPath, { recursive: true });
          await writeFile(join(binPath, "tsc"), "");
        },
      });

      expect(result.status).toBe("installed");
      await expect(access(join(root, "node_modules"))).resolves.toBeUndefined();
      await expect(git(root, ["status", "--porcelain=v1"])).resolves.toEqual(
        Buffer.alloc(0),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects and materializes a locked uv environment through the shared cache", async () => {
    const root = await mkTestWorkspace("subscription-runtime-deps-uv-");
    const cacheRoot = join(root, "cache");
    try {
      await writeFile(
        join(root, "pyproject.toml"),
        "[project]\nname='fixture'\n",
      );
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
        environmentPath: join(await realpath(root), ".venv"),
        environmentExists: true,
        packageManager: {
          name: "uv",
          source: "lockfile",
          lockfilePath: join(await realpath(root), "uv.lock"),
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
    process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT =
      "/var/cache/agents";
    try {
      const namespace = dependencyCacheNamespace("777genius/infinity-context");
      expect(namespace).toMatch(/^777genius-infinity-context-[a-f0-9]{12}$/);
      expect(
        defaultDependencyCacheRoot({
          workspacePath: "/tmp/workspace",
          cacheNamespace: "777genius/infinity-context",
        }),
      ).toBe(join("/var/cache/agents", namespace));
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
      expect(() =>
        defaultDependencyCacheRoot({
          workspacePath: "/tmp/workspace",
        }),
      ).toThrowError("dependency_cache_root_must_be_absolute");
    } finally {
      if (previous === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT = previous;
      }
    }
  });

  it("rejects a relative explicit cache root", () => {
    expect(() =>
      defaultDependencyCacheRoot({
        workspacePath: "/tmp/workspace",
        cacheRoot: "relative/cache",
      }),
    ).toThrowError("dependency_cache_root_must_be_absolute");
  });

  it("fails before installation when the explicit cache root is relative", async () => {
    const root = await mkTestWorkspace(
      "subscription-runtime-deps-relative-cache-",
    );
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({}));
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {},
        }),
      );

      await expect(
        runDependencyBootstrap({
          workspacePath: root,
          cacheRoot: "relative/cache",
          mode: "install",
          confirmInstall: true,
          runCommand: async () => {
            throw new Error("install must not run");
          },
        }),
      ).rejects.toThrowError("dependency_cache_root_must_be_absolute");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not allow a Node packageManager field to select the Python adapter", async () => {
    const root = await mkTestWorkspace(
      "subscription-runtime-deps-node-manager-",
    );
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "uv@0.8.0",
        }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {},
        }),
      );

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

async function mkGitDependencyWorkspace(
  prefix: string,
  packageManager: "npm" | "pnpm",
): Promise<string> {
  const root = await mkTestWorkspace(prefix);
  await git(root, ["init", "--quiet"]);
  await Promise.all([
    writeFile(join(root, ".gitignore"), "node_modules/\n"),
    writeFile(join(root, "README.md"), "fixture\n"),
    writeFile(
      join(root, "package.json"),
      JSON.stringify({
        packageManager:
          packageManager === "pnpm" ? "pnpm@9.15.0" : "npm@11.0.0",
      }),
    ),
    packageManager === "pnpm"
      ? writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      : writeFile(
          join(root, "package-lock.json"),
          JSON.stringify({ lockfileVersion: 3, packages: {} }),
        ),
    ...(packageManager === "pnpm"
      ? [
          writeFile(
            join(root, "pnpm-workspace.yaml"),
            "packages:\n  - packages/*\n",
          ),
        ]
      : []),
  ]);
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Dependency Bootstrap Test",
    "-c",
    "user.email=dependency-bootstrap@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test: initialize dependency workspace",
  ]);
  return root;
}

async function git(root: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "buffer",
  });
  return result.stdout;
}
