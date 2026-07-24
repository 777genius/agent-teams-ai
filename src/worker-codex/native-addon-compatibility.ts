import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverNativeAddonFilesNative } from "./dependency-native-traversal";

const MAX_DEPENDENCY_ENTRIES_SCAN = 300_000;
const MAX_NATIVE_ADDONS_SCAN = 4_096;
const MAX_NATIVE_ADDON_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_ADDON_AGGREGATE_BYTES = 128 * 1024 * 1024;
const MAX_NATIVE_ADDON_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_NATIVE_ADDON_INSPECTION_MS = 30_000;
const MAX_DIRECTORY_SCAN_CONCURRENCY = 16;
const CLASSIC_NODE_MODULE_SYMBOL = /node_register_module_v(\d+)/g;
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export type NativeAddonCompatibilityResult = {
  readonly expectedAbi: string;
  readonly inspectedAddonCount: number;
  readonly inspectedAddonPaths: readonly string[];
  readonly incompatibleAddonCount: number;
  readonly incompatiblePackageNames: readonly string[];
};

export async function inspectNativeAddonCompatibility(
  workspacePath: string,
  expectedAbi = process.versions.modules,
): Promise<NativeAddonCompatibilityResult> {
  const deadline = Date.now() + MAX_NATIVE_ADDON_INSPECTION_MS;
  if (!expectedAbi) {
    throw new Error("dependency_native_addon_abi_unavailable");
  }
  const nodeModulesPath = join(workspacePath, "node_modules");
  const nodeModulesRealPath = await realpath(nodeModulesPath);
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
    const addonLstat = await lstat(addonPath);
    if (addonLstat.isSymbolicLink() || !addonLstat.isFile()) {
      throw new Error("dependency_native_addon_binary_type_invalid");
    }
    const addonRealPath = await realpath(addonPath);
    if (!isWithinDependencyRoot(addonRealPath, nodeModulesRealPath)) {
      throw new Error("dependency_native_addon_binary_outside_dependency");
    }
    const addonStat = await stat(addonRealPath);
    if (addonStat.size > MAX_NATIVE_ADDON_BYTES) {
      throw new Error("dependency_native_addon_binary_size_limit_exceeded");
    }
    aggregateBytes += addonStat.size;
    if (aggregateBytes > MAX_NATIVE_ADDON_AGGREGATE_BYTES) {
      throw new Error("dependency_native_addon_aggregate_size_limit_exceeded");
    }
    materializedAddons.push({ path: addonRealPath, size: addonStat.size });
  }

  let incompatibleAddonCount = 0;
  const incompatiblePackageNames = new Set<string>();
  for (const addon of materializedAddons) {
    assertInspectionDeadline(deadline);
    const versions = await classicNodeModuleVersions(addon.path, addon.size);
    if (
      versions.length > 0 &&
      versions.some((version) => version !== expectedAbi)
    ) {
      incompatibleAddonCount += 1;
      incompatiblePackageNames.add(
        await resolveNativeAddonPackageName(
          addon.path,
          nodeModulesRealPath,
          nodeModulesRealPath,
          deadline,
        ),
      );
    }
  }
  return {
    expectedAbi,
    inspectedAddonCount: materializedAddons.length,
    inspectedAddonPaths: materializedAddons.map((addon) => addon.path),
    incompatibleAddonCount,
    incompatiblePackageNames: [...incompatiblePackageNames].sort(),
  };
}

async function resolveNativeAddonPackageName(
  addonPath: string,
  nodeModulesPath: string,
  nodeModulesRealPath: string,
  deadline: number,
): Promise<string> {
  let cursor = dirname(addonPath);
  while (
    cursor !== nodeModulesPath &&
    isWithinDependencyRoot(cursor, nodeModulesPath)
  ) {
    assertInspectionDeadline(deadline);
    try {
      const packageJson = JSON.parse(
        await readBoundedPackageJson(
          join(cursor, "package.json"),
          cursor,
          nodeModulesRealPath,
        ),
      ) as { readonly name?: unknown };
      if (
        typeof packageJson.name !== "string" ||
        packageJson.name.length > 214 ||
        !PACKAGE_NAME_PATTERN.test(packageJson.name)
      ) {
        throw new Error("dependency_native_addon_package_name_invalid");
      }
      return packageJson.name;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("dependency_native_addon_package_unresolved");
}

async function readBoundedPackageJson(
  packageJsonPath: string,
  packageRoot: string,
  dependencyRootRealPath: string,
): Promise<string> {
  const packageJsonStat = await lstat(packageJsonPath);
  if (packageJsonStat.isSymbolicLink() || !packageJsonStat.isFile()) {
    throw new Error("dependency_native_addon_package_json_type_invalid");
  }
  const [packageJsonRealPath, packageRootRealPath] = await Promise.all([
    realpath(packageJsonPath),
    realpath(packageRoot),
  ]);
  if (
    dirname(packageJsonRealPath) !== packageRootRealPath ||
    !isWithinDependencyRoot(packageJsonRealPath, dependencyRootRealPath)
  ) {
    throw new Error("dependency_native_addon_package_json_outside_dependency");
  }
  const handle = await open(
    packageJsonPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== packageJsonStat.dev ||
      openedStat.ino !== packageJsonStat.ino
    ) {
      throw new Error("dependency_native_addon_package_json_changed");
    }
    if (openedStat.size > MAX_NATIVE_ADDON_PACKAGE_JSON_BYTES) {
      throw new Error("dependency_native_addon_package_json_size_exceeded");
    }
    const contents = Buffer.alloc(openedStat.size + 1);
    let bytesRead = 0;
    while (bytesRead < contents.byteLength) {
      const read = await handle.read(
        contents,
        bytesRead,
        contents.byteLength - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead !== openedStat.size) {
      throw new Error("dependency_native_addon_package_json_changed");
    }
    return contents.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function isWithinDependencyRoot(
  candidatePath: string,
  dependencyRoot: string,
): boolean {
  const relativePath = relative(dependencyRoot, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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

async function classicNodeModuleVersions(
  addonPath: string,
  expectedSize: number,
): Promise<readonly string[]> {
  const handle = await open(
    addonPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.size > MAX_NATIVE_ADDON_BYTES ||
      openedStat.size !== expectedSize
    ) {
      throw new Error("dependency_native_addon_binary_size_limit_exceeded");
    }
    const contents = Buffer.alloc(openedStat.size);
    let bytesRead = 0;
    while (bytesRead < contents.byteLength) {
      const read = await handle.read(
        contents,
        bytesRead,
        contents.byteLength - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const finalStat = await handle.stat();
    if (
      bytesRead !== openedStat.size ||
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino ||
      finalStat.size !== openedStat.size ||
      finalStat.mtimeMs !== openedStat.mtimeMs
    ) {
      throw new Error("dependency_native_addon_binary_changed");
    }
    return Array.from(
      contents.toString("latin1").matchAll(CLASSIC_NODE_MODULE_SYMBOL),
      (match) => String(match[1]),
    );
  } finally {
    await handle.close();
  }
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
