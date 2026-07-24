import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { discoverNativeAddonFilesNative } from "./dependency-native-traversal";

const MAX_DEPENDENCY_ENTRIES_SCAN = 300_000;
const MAX_NATIVE_ADDONS_SCAN = 4_096;
const MAX_NATIVE_ADDON_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_ADDON_AGGREGATE_BYTES = 128 * 1024 * 1024;
const MAX_NATIVE_ADDON_INSPECTION_MS = 30_000;
const MAX_DIRECTORY_SCAN_CONCURRENCY = 16;
const CLASSIC_NODE_MODULE_SYMBOL = /node_register_module_v(\d+)/g;

export type NativeAddonCompatibilityResult = {
  readonly expectedAbi: string;
  readonly inspectedAddonCount: number;
  readonly incompatibleAddonCount: number;
};

export async function inspectNativeAddonCompatibility(
  workspacePath: string,
): Promise<NativeAddonCompatibilityResult> {
  const deadline = Date.now() + MAX_NATIVE_ADDON_INSPECTION_MS;
  const expectedAbi = process.versions.modules;
  if (!expectedAbi) {
    throw new Error("dependency_native_addon_abi_unavailable");
  }
  const nodeModulesPath = join(workspacePath, "node_modules");
  const nativeAddonPaths =
    (await discoverNativeAddonFilesNative({
      dependencyRoot: nodeModulesPath,
      limits: { maxDependencyEntries: MAX_DEPENDENCY_ENTRIES_SCAN },
    })) ??
    (await discoverNativeAddonFilesJavascript(nodeModulesPath, deadline));
  if (nativeAddonPaths.length > MAX_NATIVE_ADDONS_SCAN) {
    throw new Error("dependency_native_addon_scan_limit_exceeded");
  }

  const materializedAddons: {
    readonly path: string;
    readonly size: number;
  }[] = [];
  let aggregateBytes = 0;
  for (const addonPath of nativeAddonPaths) {
    assertInspectionDeadline(deadline);
    const workspaceRelativePath = relative(workspacePath, addonPath);
    if (!isMaterializedNodeGypArtifact(workspaceRelativePath)) continue;
    const addonStat = await stat(addonPath);
    if (addonStat.size > MAX_NATIVE_ADDON_BYTES) {
      throw new Error("dependency_native_addon_binary_size_limit_exceeded");
    }
    aggregateBytes += addonStat.size;
    if (aggregateBytes > MAX_NATIVE_ADDON_AGGREGATE_BYTES) {
      throw new Error("dependency_native_addon_aggregate_size_limit_exceeded");
    }
    materializedAddons.push({ path: addonPath, size: addonStat.size });
  }

  let incompatibleAddonCount = 0;
  for (const addon of materializedAddons) {
    assertInspectionDeadline(deadline);
    const versions = await classicNodeModuleVersions(addon.path, addon.size);
    if (
      versions.length > 0 &&
      versions.some((version) => version !== expectedAbi)
    ) {
      incompatibleAddonCount += 1;
    }
  }
  return {
    expectedAbi,
    inspectedAddonCount: materializedAddons.length,
    incompatibleAddonCount,
  };
}

async function discoverNativeAddonFilesJavascript(
  dependencyRoot: string,
  deadline: number,
): Promise<readonly string[]> {
  const queue = [dependencyRoot];
  const nativeAddonPaths: string[] = [];
  let cursor = 0;
  let scanned = 0;
  while (cursor < queue.length) {
    assertInspectionDeadline(deadline);
    const directories = queue.slice(
      cursor,
      cursor + MAX_DIRECTORY_SCAN_CONCURRENCY,
    );
    cursor += directories.length;
    const batches = await Promise.all(
      directories.map(async (directory) => ({
        directory,
        entries: await readdir(directory, { withFileTypes: true }),
      })),
    );
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_DEPENDENCY_ENTRIES_SCAN) {
          throw new Error("dependency_environment_tree_scan_limit_exceeded");
        }
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          queue.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".node")) {
          nativeAddonPaths.push(entryPath);
        }
      }
    }
  }
  return nativeAddonPaths;
}

function isMaterializedNodeGypArtifact(workspaceRelativePath: string): boolean {
  const normalized = workspaceRelativePath.split(sep).join("/");
  return (
    /\/build\/(?:Release|Debug)\/[^/]+\.node$/.test(normalized) ||
    /\/(?:node-v|node_abi-)\d+\/[^/]+\.node$/.test(normalized)
  );
}

async function classicNodeModuleVersions(
  addonPath: string,
  expectedSize: number,
): Promise<readonly string[]> {
  const contents = await readFile(addonPath);
  if (
    contents.byteLength > MAX_NATIVE_ADDON_BYTES ||
    contents.byteLength !== expectedSize
  ) {
    throw new Error("dependency_native_addon_binary_size_limit_exceeded");
  }
  return Array.from(
    contents.toString("latin1").matchAll(CLASSIC_NODE_MODULE_SYMBOL),
    (match) => String(match[1]),
  );
}

export async function resolveNativeAddonHeaderRoot(
  nodeExecutablePath = process.execPath,
): Promise<string | undefined> {
  const executablePaths = [nodeExecutablePath];
  try {
    executablePaths.push(await realpath(nodeExecutablePath));
  } catch {
    // The lexical executable prefix remains a valid bounded candidate.
  }
  const candidates = Array.from(
    new Set(
      executablePaths.flatMap((executablePath) => {
        const executableDirectory = dirname(executablePath);
        return [executableDirectory, resolve(executableDirectory, "..")];
      }),
    ),
  );
  for (const candidate of candidates) {
    try {
      const header = await stat(join(candidate, "include", "node", "node.h"));
      if (header.isFile()) return candidate;
    } catch {
      // Only prefixes derived from the selected executable are probed.
    }
  }
  return undefined;
}

function assertInspectionDeadline(deadline: number): void {
  if (Date.now() > deadline) {
    throw new Error("dependency_native_addon_inspection_timeout");
  }
}
