import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PLACEMENTS = 128;

type DependencyCachePlacement = {
  readonly workspaceRoot: string;
  readonly cacheRoot: string;
};

type DependencyCachePlacementConfig = {
  readonly schemaVersion: 1;
  readonly placements: readonly DependencyCachePlacement[];
};

export type DependencyCacheResolutionInput = {
  readonly workspacePath: string;
  readonly jobRootDir?: string;
  readonly cacheRoot?: string;
  readonly cacheNamespace?: string;
};

export async function resolveDependencyCacheRoot(
  input: DependencyCacheResolutionInput,
): Promise<string | undefined> {
  if (input.cacheRoot) return absoluteCacheRoot(input.cacheRoot);

  const configPath = process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_CONFIG?.trim();
  if (configPath) {
    const placement = await resolveConfiguredPlacement(configPath, input.workspacePath);
    return join(
      placement.cacheRoot,
      dependencyCacheNamespace(input.cacheNamespace ?? input.workspacePath),
    );
  }
  return defaultDependencyCacheRoot(input);
}

export function defaultDependencyCacheRoot(
  input: DependencyCacheResolutionInput,
): string | undefined {
  if (input.cacheRoot) return absoluteCacheRoot(input.cacheRoot);
  const configuredRoot = process.env.SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT?.trim();
  if (configuredRoot) {
    return join(
      absoluteCacheRoot(configuredRoot),
      dependencyCacheNamespace(input.cacheNamespace ?? input.workspacePath),
    );
  }
  if (!input.jobRootDir) return undefined;
  return join(dirname(input.jobRootDir), ".dependency-cache");
}

export function dependencyCacheNamespace(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

async function resolveConfiguredPlacement(
  configPath: string,
  workspacePath: string,
): Promise<DependencyCachePlacement> {
  if (!isAbsolute(configPath)) throw new Error("dependency_cache_config_must_be_absolute");
  const configStat = await lstat(configPath);
  if (configStat.isSymbolicLink()) throw new Error("dependency_cache_config_symlink_denied");
  if (!configStat.isFile()) throw new Error("dependency_cache_config_not_file");
  if ((configStat.mode & 0o022) !== 0) {
    throw new Error("dependency_cache_config_must_not_be_group_or_world_writable");
  }
  if (configStat.size > MAX_CONFIG_BYTES) throw new Error("dependency_cache_config_too_large");

  const config = parsePlacementConfig(await readFile(configPath, "utf8"));
  const canonicalWorkspace = await realpath(workspacePath);
  const candidates = await Promise.all(config.placements.map(async (placement) => ({
    placement,
    canonicalRoot: await realpath(placement.workspaceRoot),
  })));
  const match = candidates
    .filter(({ canonicalRoot }) => pathInsideOrEqual(canonicalWorkspace, canonicalRoot))
    .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0];
  if (!match) throw new Error("dependency_cache_placement_not_found");
  return match.placement;
}

function parsePlacementConfig(raw: string): DependencyCachePlacementConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("dependency_cache_config_invalid_json");
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.placements)) {
    throw new Error("dependency_cache_config_invalid_shape");
  }
  if (value.placements.length === 0 || value.placements.length > MAX_PLACEMENTS) {
    throw new Error("dependency_cache_config_invalid_placement_count");
  }
  const seen = new Set<string>();
  const placements = value.placements.map((item) => {
    if (!isRecord(item) || typeof item.workspaceRoot !== "string" ||
      typeof item.cacheRoot !== "string") {
      throw new Error("dependency_cache_config_invalid_placement");
    }
    if (!isAbsolute(item.workspaceRoot) || !isAbsolute(item.cacheRoot)) {
      throw new Error("dependency_cache_placement_paths_must_be_absolute");
    }
    if (seen.has(item.workspaceRoot)) {
      throw new Error("dependency_cache_config_duplicate_workspace_root");
    }
    seen.add(item.workspaceRoot);
    return { workspaceRoot: item.workspaceRoot, cacheRoot: item.cacheRoot };
  });
  return { schemaVersion: 1, placements };
}

function absoluteCacheRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error("dependency_cache_root_must_be_absolute");
  return value;
}

function pathInsideOrEqual(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
