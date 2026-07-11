import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDependencyCacheRoot } from "../dependency-cache-placement";

const previousConfig = process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG;

afterEach(() => {
  if (previousConfig === undefined) {
    delete process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG;
  } else {
    process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG = previousConfig;
  }
});

describe("dependency cache placement", () => {
  it("selects the longest matching operator-owned workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "dependency-placement-"));
    try {
      const workspaces = join(root, "workspaces");
      const volume = join(workspaces, "volume");
      const workspace = join(volume, "job-a");
      await mkdir(workspace, { recursive: true });
      const configPath = await writeConfig(root, [
        { workspaceRoot: workspaces, cacheRoot: join(root, "root-cache") },
        { workspaceRoot: volume, cacheRoot: join(root, "volume-cache") },
      ]);
      process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG = configPath;

      await expect(resolveDependencyCacheRoot({
        workspacePath: workspace,
        cacheNamespace: "project-a",
      })).resolves.toMatch(/^.*volume-cache\/project-a-[a-f0-9]{12}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when configured routing has no workspace match", async () => {
    const root = await mkdtemp(join(tmpdir(), "dependency-placement-missing-"));
    try {
      const allowed = join(root, "allowed");
      const workspace = join(root, "other", "job-a");
      await mkdir(allowed, { recursive: true });
      await mkdir(workspace, { recursive: true });
      process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG = await writeConfig(root, [
        { workspaceRoot: allowed, cacheRoot: join(root, "cache") },
      ]);

      await expect(resolveDependencyCacheRoot({ workspacePath: workspace }))
        .rejects.toThrowError("dependency_cache_placement_not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked and writable placement configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "dependency-placement-policy-"));
    try {
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const configPath = await writeConfig(root, [
        { workspaceRoot: workspace, cacheRoot: join(root, "cache") },
      ]);
      const linkPath = join(root, "placements-link.json");
      await symlink(configPath, linkPath);
      process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG = linkPath;
      await expect(resolveDependencyCacheRoot({ workspacePath: workspace }))
        .rejects.toThrowError("dependency_cache_config_symlink_denied");

      await chmod(configPath, 0o666);
      process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG = configPath;
      await expect(resolveDependencyCacheRoot({ workspacePath: workspace }))
        .rejects.toThrowError("dependency_cache_config_must_not_be_group_or_world_writable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeConfig(
  root: string,
  placements: readonly { readonly workspaceRoot: string; readonly cacheRoot: string }[],
): Promise<string> {
  const path = join(root, `placements-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, placements }), { mode: 0o600 });
  return path;
}
