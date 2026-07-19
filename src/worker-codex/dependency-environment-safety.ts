import { lstat, readdir, readlink, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_PACKAGE_ROOTS_SCAN = 10_000;
const MAX_DEPENDENCY_ENTRIES_SCAN = 250_000;
const MAX_LINK_RESOLUTION_CONCURRENCY = 32;
const PACKAGE_SCAN_EXCLUDED_DIRS = new Set([
  ".git",
  ".cache",
  ".pnpm-store",
  "dist",
  "node_modules",
]);

export type NodeDependencyEnvironmentInspection = {
  readonly dependencyRoots: readonly string[];
  readonly unsafeDependencyRoots: readonly string[];
};

type InternalNodeDependencyEnvironmentInspection = {
  readonly workspaceRealPath: string;
  readonly dependencyRoots: readonly string[];
  readonly unsafeDependencyRoots: readonly string[];
};

export async function inspectNodeDependencyEnvironment(input: {
  readonly workspacePath: string;
}): Promise<NodeDependencyEnvironmentInspection> {
  const inspection = await inspectNodeDependencyEnvironmentInternal(input);
  return {
    dependencyRoots: inspection.dependencyRoots.map((path) =>
      relative(inspection.workspaceRealPath, path),
    ),
    unsafeDependencyRoots: inspection.unsafeDependencyRoots.map((path) =>
      relative(inspection.workspaceRealPath, path),
    ),
  };
}

async function inspectNodeDependencyEnvironmentInternal(input: {
  readonly workspacePath: string;
}): Promise<InternalNodeDependencyEnvironmentInspection> {
  const workspaceRealPath = await realpath(input.workspacePath);
  const dependencyRoots = await nodeDependencyRoots(workspaceRealPath);
  const unsafeDependencyRoots: string[] = [];
  for (const dependencyRoot of dependencyRoots) {
    if (await dependencyRootIsUnsafe(dependencyRoot, workspaceRealPath)) {
      unsafeDependencyRoots.push(dependencyRoot);
    }
  }
  return {
    workspaceRealPath,
    dependencyRoots,
    unsafeDependencyRoots: unsafeDependencyRoots.sort(),
  };
}

export async function sanitizeNodeDependencyEnvironment(input: {
  readonly workspacePath: string;
}): Promise<{ readonly removedPaths: readonly string[] }> {
  const inspection = await inspectNodeDependencyEnvironmentInternal(input);
  const removedPaths: string[] = [];
  for (const dependencyRoot of inspection.unsafeDependencyRoots) {
    if (
      !(await dependencyRootIsUnsafe(
        dependencyRoot,
        inspection.workspaceRealPath,
      ))
    ) {
      continue;
    }
    await rm(dependencyRoot, {
      recursive: true,
      force: false,
    });
    removedPaths.push(relative(inspection.workspaceRealPath, dependencyRoot));
  }
  return { removedPaths: removedPaths.sort() };
}

async function nodeDependencyRoots(
  workspaceRealPath: string,
): Promise<readonly string[]> {
  const queue = [workspaceRealPath];
  const roots: string[] = [];
  let cursor = 0;
  let scanned = 0;
  while (cursor < queue.length) {
    const directory = queue[cursor++];
    if (!directory) break;
    scanned += 1;
    if (scanned > MAX_PACKAGE_ROOTS_SCAN) {
      throw new Error("dependency_environment_package_scan_limit_exceeded");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") {
        roots.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isDirectory() || PACKAGE_SCAN_EXCLUDED_DIRS.has(entry.name))
        continue;
      queue.push(join(directory, entry.name));
    }
  }
  return roots.sort();
}

async function dependencyRootIsUnsafe(
  dependencyRoot: string,
  workspaceRealPath: string,
): Promise<boolean> {
  let status;
  try {
    status = await lstat(dependencyRoot);
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
  if (status.isSymbolicLink()) return true;
  if (!status.isDirectory()) {
    throw new Error("dependency_environment_root_invalid");
  }
  const dependencyRealPath = await realpath(dependencyRoot);
  if (!pathWithin(workspaceRealPath, dependencyRealPath)) return true;
  return dependencyTreeContainsEscapingLink(
    dependencyRoot,
    new DependencyLinkTargetResolver(workspaceRealPath),
  );
}

async function dependencyTreeContainsEscapingLink(
  dependencyRoot: string,
  linkTargetResolver: DependencyLinkTargetResolver,
): Promise<boolean> {
  const queue = [dependencyRoot];
  const linkPaths: string[] = [];
  let cursor = 0;
  let scanned = 0;
  while (cursor < queue.length) {
    const directory = queue[cursor++];
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_DEPENDENCY_ENTRIES_SCAN) {
        throw new Error("dependency_environment_tree_scan_limit_exceeded");
      }
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        linkPaths.push(entryPath);
        continue;
      }
      if (entry.isDirectory()) queue.push(entryPath);
    }
  }
  return linkTargetResolver.containsUnsafeLink(linkPaths);
}

class DependencyLinkTargetResolver {
  readonly #workspaceRealPath: string;
  readonly #targetRealPathCache = new Map<string, Promise<string>>();

  constructor(workspaceRealPath: string) {
    this.#workspaceRealPath = workspaceRealPath;
  }

  async containsUnsafeLink(linkPaths: readonly string[]): Promise<boolean> {
    let cursor = 0;
    let unsafe = false;
    const workers = Array.from(
      {
        length: Math.min(MAX_LINK_RESOLUTION_CONCURRENCY, linkPaths.length),
      },
      async () => {
        while (!unsafe) {
          const linkPath = linkPaths[cursor++];
          if (!linkPath) return;
          if (await this.#linkIsUnsafe(linkPath)) {
            unsafe = true;
            return;
          }
        }
      },
    );
    await Promise.all(workers);
    return unsafe;
  }

  async #linkIsUnsafe(linkPath: string): Promise<boolean> {
    let rawTarget: string;
    try {
      rawTarget = await readlink(linkPath);
    } catch (error) {
      if (isMissingError(error) || isInvalidSymlinkError(error)) return true;
      throw error;
    }

    const lexicalTargetPath = resolve(dirname(linkPath), rawTarget);
    let targetRealPath: string;
    try {
      targetRealPath = await this.#resolveTargetRealPath(lexicalTargetPath);
    } catch (error) {
      if (isMissingError(error)) return true;
      throw error;
    }
    return !pathWithin(this.#workspaceRealPath, targetRealPath);
  }

  #resolveTargetRealPath(lexicalTargetPath: string): Promise<string> {
    const cached = this.#targetRealPathCache.get(lexicalTargetPath);
    if (cached) return cached;
    const resolution = realpath(lexicalTargetPath);
    this.#targetRealPathCache.set(lexicalTargetPath, resolution);
    return resolution;
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isInvalidSymlinkError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EINVAL";
}
