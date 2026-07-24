import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PNPM_NATIVE_GENERATION_SCHEMA_VERSION = 2;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;
const MAX_STORE_ENTRIES = 500_000;
const MAX_STORE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_BUILD_POLICY_ENTRIES = 100_000;
const MAX_BUILD_POLICY_FILE_BYTES = 16 * 1024 * 1024;

export type PnpmNativeGenerationIdentity = {
  readonly schemaVersion: 2;
  readonly dependencyFingerprint: string;
  readonly buildPolicyFingerprint: string;
  readonly nodeVersion: string;
  readonly nodeModulesAbi: string;
  readonly platform: string;
  readonly arch: string;
  readonly pnpmVersion: string;
  readonly libcIdentity: string;
  readonly toolchainIdentity: string;
};

export type PnpmNativeGenerationVerification = {
  readonly expectedAbi: string;
  readonly inspectedAddonCount: number;
};

export type VerifiedPnpmNativeGeneration = {
  readonly key: string;
  readonly generationPath: string;
  readonly storePath: string;
  readonly verification: PnpmNativeGenerationVerification;
};

export type StagedPnpmNativeGeneration = {
  readonly key: string;
  readonly stagingPath: string;
  readonly storePath: string;
};

type PnpmNativeGenerationManifest = {
  readonly schemaVersion: 2;
  readonly key: string;
  readonly identity: PnpmNativeGenerationIdentity;
  readonly verification: PnpmNativeGenerationVerification;
  readonly storeIntegrity: PnpmNativeStoreIntegrity;
};

type PnpmNativeStoreIntegrity = {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly byteCount: number;
};

export async function resolvePnpmNativeGenerationIdentity(input: {
  readonly workspacePath: string;
  readonly dependencyFingerprint: string;
  readonly packageManagerVersionSpec?: string;
  readonly nodeExecutablePath?: string;
  readonly commandIsInjected: boolean;
}): Promise<PnpmNativeGenerationIdentity> {
  const [
    node,
    pnpmVersion,
    libcIdentity,
    toolchainIdentity,
    buildPolicyFingerprint,
  ] = await Promise.all([
    resolveTargetNodeIdentity(input.nodeExecutablePath),
    resolveEffectivePnpmVersion(input),
    resolveLibcIdentity(),
    resolveToolchainIdentity(),
    resolvePnpmBuildPolicyFingerprint(input.workspacePath),
  ]);
  return {
    schemaVersion: PNPM_NATIVE_GENERATION_SCHEMA_VERSION,
    dependencyFingerprint: input.dependencyFingerprint,
    buildPolicyFingerprint,
    nodeVersion: node.version,
    nodeModulesAbi: node.modulesAbi,
    platform: node.platform,
    arch: node.arch,
    pnpmVersion,
    libcIdentity,
    toolchainIdentity,
  };
}

export function pnpmNativeGenerationKey(
  identity: PnpmNativeGenerationIdentity,
): string {
  return createHash("sha256")
    .update(
      [
        `schema=${identity.schemaVersion}`,
        `dependencyFingerprint=${identity.dependencyFingerprint}`,
        `buildPolicyFingerprint=${identity.buildPolicyFingerprint}`,
        `nodeVersion=${identity.nodeVersion}`,
        `nodeModulesAbi=${identity.nodeModulesAbi}`,
        `platform=${identity.platform}`,
        `arch=${identity.arch}`,
        `pnpmVersion=${identity.pnpmVersion}`,
        `libcIdentity=${identity.libcIdentity}`,
        `toolchainIdentity=${identity.toolchainIdentity}`,
      ].join("\n"),
    )
    .digest("hex");
}

export async function findVerifiedPnpmNativeGeneration(
  cacheRoot: string,
  identity: PnpmNativeGenerationIdentity,
): Promise<VerifiedPnpmNativeGeneration | undefined> {
  const key = pnpmNativeGenerationKey(identity);
  const generationRoot = await ensureGenerationRoot(cacheRoot);
  const generationPath = generationPathFor(cacheRoot, key);
  let generationStat;
  try {
    generationStat = await lstat(generationPath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
  try {
    if (generationStat.isSymbolicLink() || !generationStat.isDirectory()) {
      throw new Error("dependency_pnpm_native_generation_type_invalid");
    }
    await assertContainedRealPath(generationRoot, generationPath);
    const manifestPath = join(generationPath, "manifest.json");
    const manifestStat = await lstat(manifestPath);
    if (
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      manifestStat.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error("dependency_pnpm_native_generation_manifest_invalid");
    }
    const manifest = parseManifest(
      (await readRegularFileNoFollow(manifestPath, manifestStat.size)).toString(
        "utf8",
      ),
    );
    if (
      manifest.key !== key ||
      pnpmNativeGenerationKey(manifest.identity) !== key ||
      !sameIdentity(manifest.identity, identity) ||
      manifest.verification.expectedAbi !== identity.nodeModulesAbi
    ) {
      throw new Error("dependency_pnpm_native_generation_identity_mismatch");
    }

    const storePath = join(generationPath, "store");
    const storeStat = await lstat(storePath);
    if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) {
      throw new Error("dependency_pnpm_native_generation_store_invalid");
    }
    await assertContainedRealPath(generationPath, storePath);
    await removePnpmStoreProjectRegistryLinks(storePath);
    const actualIntegrity = await inspectStoreIntegrity(storePath);
    if (!sameStoreIntegrity(actualIntegrity, manifest.storeIntegrity)) {
      throw new Error("dependency_pnpm_native_generation_integrity_mismatch");
    }
    return {
      key,
      generationPath,
      storePath,
      verification: manifest.verification,
    };
  } catch (error) {
    await quarantineGeneration(generationRoot, generationPath, key);
    if (isGenerationValidationError(error)) return undefined;
    throw error;
  }
}

export async function createStagedPnpmNativeGeneration(
  cacheRoot: string,
  identity: PnpmNativeGenerationIdentity,
): Promise<StagedPnpmNativeGeneration> {
  const key = pnpmNativeGenerationKey(identity);
  const generationRoot = await ensureGenerationRoot(cacheRoot);
  const stagingRoot = join(generationRoot, ".staging");
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(stagingRoot, generationRoot);
  const stagingPath = await mkdtemp(join(stagingRoot, `${key}-`));
  const storePath = join(stagingPath, "store");
  await mkdir(storePath, { recursive: true, mode: 0o700 });
  return { key, stagingPath, storePath };
}

export async function publishStagedPnpmNativeGeneration(input: {
  readonly cacheRoot: string;
  readonly identity: PnpmNativeGenerationIdentity;
  readonly staged: StagedPnpmNativeGeneration;
  readonly verification: PnpmNativeGenerationVerification;
}): Promise<VerifiedPnpmNativeGeneration> {
  const expectedKey = pnpmNativeGenerationKey(input.identity);
  if (input.staged.key !== expectedKey) {
    throw new Error("dependency_pnpm_native_generation_staging_key_mismatch");
  }
  await removePnpmStoreProjectRegistryLinks(input.staged.storePath);
  await inspectStoreIntegrity(input.staged.storePath);
  await sealStoreReadOnly(input.staged.storePath);
  const sealedIntegrity = await inspectStoreIntegrity(input.staged.storePath);
  const confirmedIntegrity = await inspectStoreIntegrity(
    input.staged.storePath,
  );
  if (!sameStoreIntegrity(sealedIntegrity, confirmedIntegrity)) {
    throw new Error("dependency_pnpm_native_generation_seal_changed");
  }
  const manifest: PnpmNativeGenerationManifest = {
    schemaVersion: PNPM_NATIVE_GENERATION_SCHEMA_VERSION,
    key: expectedKey,
    identity: input.identity,
    verification: input.verification,
    storeIntegrity: sealedIntegrity,
  };
  await writeFile(
    join(input.staged.stagingPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );

  const generationRoot = await ensureGenerationRoot(input.cacheRoot);
  const generationPath = generationPathFor(input.cacheRoot, expectedKey);
  await chmod(join(input.staged.stagingPath, "manifest.json"), 0o400);
  try {
    await rename(input.staged.stagingPath, generationPath);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const existing = await findVerifiedPnpmNativeGeneration(
      input.cacheRoot,
      input.identity,
    );
    if (!existing) {
      throw new Error("dependency_pnpm_native_generation_publish_conflict");
    }
    return existing;
  }
  await assertContainedRealPath(generationRoot, generationPath);
  return {
    key: expectedKey,
    generationPath,
    storePath: join(generationPath, "store"),
    verification: input.verification,
  };
}

export async function removeStagedPnpmNativeGeneration(
  staged: StagedPnpmNativeGeneration,
): Promise<void> {
  await makeTreeOwnerWritable(staged.stagingPath);
  await rm(staged.stagingPath, { recursive: true, force: true });
}

export async function removePnpmStoreProjectRegistryLinks(
  storePath: string,
): Promise<number> {
  const storeStat = await lstat(storePath);
  if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) {
    throw new Error("dependency_pnpm_native_generation_store_invalid");
  }
  let removed = 0;
  for (const versionEntry of await readdir(storePath, {
    withFileTypes: true,
  })) {
    if (!versionEntry.isDirectory() || !/^v\d+$/.test(versionEntry.name)) {
      continue;
    }
    const registryPath = join(storePath, versionEntry.name, "projects");
    let registryStat;
    try {
      registryStat = await lstat(registryPath);
    } catch (error) {
      if (isMissingError(error)) continue;
      throw error;
    }
    if (registryStat.isSymbolicLink() || !registryStat.isDirectory()) {
      throw new Error(
        "dependency_pnpm_native_generation_project_registry_invalid",
      );
    }
    await assertContainedRealPath(storePath, registryPath);
    for (const entry of await readdir(registryPath, {
      withFileTypes: true,
    })) {
      const entryPath = join(registryPath, entry.name);
      const entryStat = await lstat(entryPath);
      if (!entryStat.isSymbolicLink()) {
        throw new Error(
          "dependency_pnpm_native_generation_project_registry_entry_invalid",
        );
      }
      await unlink(entryPath);
      removed += 1;
    }
  }
  return removed;
}

function generationPathFor(cacheRoot: string, key: string): string {
  return join(cacheRoot, "pnpm-native-generations", key);
}

async function ensureGenerationRoot(cacheRoot: string): Promise<string> {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const cacheStat = await lstat(cacheRoot);
  if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) {
    throw new Error("dependency_pnpm_native_cache_root_invalid");
  }
  const generationRoot = join(cacheRoot, "pnpm-native-generations");
  await mkdir(generationRoot, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(generationRoot, cacheRoot);
  return generationRoot;
}

async function assertSafeDirectory(
  path: string,
  parent: string,
): Promise<void> {
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error("dependency_pnpm_native_cache_path_invalid");
  }
  await assertContainedRealPath(parent, path);
}

async function assertContainedRealPath(
  parentPath: string,
  candidatePath: string,
): Promise<void> {
  const [parentRealPath, candidateRealPath] = await Promise.all([
    realpath(parentPath),
    realpath(candidatePath),
  ]);
  const relativePath = relative(parentRealPath, candidateRealPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("dependency_pnpm_native_cache_path_escape");
  }
}

async function inspectStoreIntegrity(
  storePath: string,
): Promise<PnpmNativeStoreIntegrity> {
  const rootRealPath = await realpath(storePath);
  const queue = [storePath];
  const records: string[] = [];
  let entryCount = 0;
  let fileCount = 0;
  let byteCount = 0;
  while (queue.length > 0) {
    const directory = queue.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_STORE_ENTRIES) {
        throw new Error("dependency_pnpm_native_generation_store_limit");
      }
      const entryPath = join(directory, entry.name);
      const entryRelativePath = relative(storePath, entryPath)
        .split(sep)
        .join("/");
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error("dependency_pnpm_native_generation_store_symlink");
      }
      await assertContainedRealPath(rootRealPath, entryPath);
      if (entryStat.isDirectory()) {
        records.push(`d\0${entryRelativePath}\0${entryStat.mode & 0o777}`);
        queue.push(entryPath);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new Error("dependency_pnpm_native_generation_store_type");
      }
      fileCount += 1;
      byteCount += entryStat.size;
      if (byteCount > MAX_STORE_BYTES) {
        throw new Error("dependency_pnpm_native_generation_store_bytes_limit");
      }
      const contents = await readRegularFileNoFollow(entryPath, entryStat.size);
      records.push(
        `f\0${entryRelativePath}\0${entryStat.mode & 0o777}\0${entryStat.size}\0${createHash(
          "sha256",
        )
          .update(contents)
          .digest("hex")}`,
      );
    }
  }
  records.sort();
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(records.join("\n")).digest("hex"),
    entryCount,
    fileCount,
    byteCount,
  };
}

async function readRegularFileNoFollow(
  path: string,
  expectedSize: number,
): Promise<string | Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size !== expectedSize) {
      throw new Error("dependency_pnpm_native_generation_file_changed");
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
      throw new Error("dependency_pnpm_native_generation_file_changed");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function sealStoreReadOnly(storePath: string): Promise<void> {
  const queue = [storePath];
  const directories: string[] = [];
  while (queue.length > 0) {
    const directory = queue.pop();
    if (!directory) break;
    directories.push(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error("dependency_pnpm_native_generation_store_symlink");
      }
      if (entryStat.isDirectory()) {
        queue.push(entryPath);
      } else if (entryStat.isFile()) {
        await chmod(entryPath, entryStat.mode & 0o111 ? 0o500 : 0o400);
      } else {
        throw new Error("dependency_pnpm_native_generation_store_type");
      }
    }
  }
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) await chmod(directory, 0o700);
}

async function makeTreeOwnerWritable(rootPath: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(rootPath);
  } catch (error) {
    if (isMissingError(error)) return;
    throw error;
  }
  if (rootStat.isSymbolicLink()) return;
  if (!rootStat.isDirectory()) {
    await chmod(rootPath, 0o600);
    return;
  }
  await chmod(rootPath, 0o700);
  const queue = [rootPath];
  while (queue.length > 0) {
    const directory = queue.pop();
    if (!directory) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        await chmod(entryPath, 0o700);
        queue.push(entryPath);
      } else if (entryStat.isFile()) {
        await chmod(entryPath, 0o600);
      }
    }
  }
}

async function quarantineGeneration(
  generationRoot: string,
  generationPath: string,
  key: string,
): Promise<void> {
  const quarantineRoot = join(generationRoot, ".quarantine");
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(quarantineRoot, generationRoot);
  await rename(
    generationPath,
    join(quarantineRoot, `${key}-${Date.now()}-${randomUUID()}`),
  );
}

function sameStoreIntegrity(
  left: PnpmNativeStoreIntegrity,
  right: PnpmNativeStoreIntegrity,
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.entryCount === right.entryCount &&
    left.fileCount === right.fileCount &&
    left.byteCount === right.byteCount
  );
}

function isGenerationValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("dependency_pnpm_native_generation_")
  );
}

async function resolveTargetNodeIdentity(
  nodeExecutablePath = process.execPath,
): Promise<{
  readonly version: string;
  readonly modulesAbi: string;
  readonly platform: string;
  readonly arch: string;
}> {
  if (nodeExecutablePath === process.execPath) {
    const modulesAbi = process.versions.modules;
    if (!modulesAbi) {
      throw new Error("dependency_native_addon_abi_unavailable");
    }
    return {
      version: process.versions.node,
      modulesAbi,
      platform: process.platform,
      arch: process.arch,
    };
  }
  const { stdout } = await execFileAsync(
    nodeExecutablePath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({version:process.versions.node,modulesAbi:process.versions.modules,platform:process.platform,arch:process.arch}))",
    ],
    { timeout: 5_000, maxBuffer: MAX_VERSION_OUTPUT_BYTES },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("dependency_target_node_identity_invalid");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.version !== "string" ||
    typeof parsed.modulesAbi !== "string" ||
    typeof parsed.platform !== "string" ||
    typeof parsed.arch !== "string" ||
    parsed.version.length === 0 ||
    parsed.modulesAbi.length === 0 ||
    parsed.platform.length === 0 ||
    parsed.arch.length === 0
  ) {
    throw new Error("dependency_target_node_identity_invalid");
  }
  return {
    version: parsed.version,
    modulesAbi: parsed.modulesAbi,
    platform: parsed.platform,
    arch: parsed.arch,
  };
}

async function resolveEffectivePnpmVersion(input: {
  readonly workspacePath: string;
  readonly packageManagerVersionSpec?: string;
  readonly commandIsInjected: boolean;
}): Promise<string> {
  if (input.commandIsInjected) {
    const declared = exactDeclaredPnpmVersion(input.packageManagerVersionSpec);
    if (!declared) {
      throw new Error("dependency_pnpm_effective_version_unavailable");
    }
    return declared;
  }
  const { stdout } = await execFileAsync("pnpm", ["--version"], {
    cwd: input.workspacePath,
    timeout: 5_000,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
  });
  const version = stdout.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version)) {
    throw new Error("dependency_pnpm_effective_version_invalid");
  }
  return version;
}

async function resolvePnpmBuildPolicyFingerprint(
  workspacePath: string,
): Promise<string> {
  const workspaceRoot = resolve(workspacePath);
  const queue = [workspaceRoot];
  const records: string[] = [];
  let scannedEntries = 0;
  while (queue.length > 0) {
    const directory = queue.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_BUILD_POLICY_ENTRIES) {
        throw new Error("dependency_pnpm_build_policy_scan_limit");
      }
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".pnpm-store" ||
        entry.name === ".yarn"
      ) {
        continue;
      }
      const entryPath = join(directory, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        if (isPnpmBuildPolicyFile(entryPath)) {
          throw new Error("dependency_pnpm_build_policy_symlink");
        }
        continue;
      }
      if (entryStat.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entryStat.isFile() || !isPnpmBuildPolicyFile(entryPath)) continue;
      if (entryStat.size > MAX_BUILD_POLICY_FILE_BYTES) {
        throw new Error("dependency_pnpm_build_policy_file_size_limit");
      }
      const contents = await readRegularFileNoFollow(entryPath, entryStat.size);
      const relativePath = relative(workspaceRoot, entryPath)
        .split(sep)
        .join("/");
      records.push(
        `${relativePath}\0${createHash("sha256").update(contents).digest("hex")}`,
      );
    }
  }
  records.sort();
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

function isPnpmBuildPolicyFile(path: string): boolean {
  const normalized = path.split(sep).join("/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    name === "package.json" ||
    name === "pnpm-workspace.yaml" ||
    name === "pnpm-workspace.yml" ||
    name === ".npmrc" ||
    name === ".pnpmfile.cjs" ||
    name === "pnpmfile.cjs" ||
    name === "pnpmfile.js" ||
    name === ".node-version" ||
    name === ".nvmrc" ||
    normalized.includes("/patches/")
  );
}

function exactDeclaredPnpmVersion(
  packageManagerVersionSpec: string | undefined,
): string | undefined {
  const match = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/.exec(
    packageManagerVersionSpec ?? "",
  );
  return match?.[1];
}

async function resolveLibcIdentity(): Promise<string> {
  const report = process.report?.getReport() as
    | {
        readonly header?: {
          readonly glibcVersionRuntime?: string;
          readonly glibcVersionCompiler?: string;
        };
      }
    | undefined;
  const runtime = report?.header?.glibcVersionRuntime;
  const compiler = report?.header?.glibcVersionCompiler;
  return [
    `platform=${platform()}`,
    `osRelease=${release()}`,
    `glibcRuntime=${runtime ?? "unavailable"}`,
    `glibcCompiler=${compiler ?? "unavailable"}`,
    await toolVersion("ldd", ["--version"]),
  ].join(";");
}

let cachedToolchainIdentity:
  { readonly cacheKey: string; readonly value: Promise<string> } | undefined;

function resolveToolchainIdentity(): Promise<string> {
  const cacheKey = [
    process.env.PATH ?? "",
    process.env.CC ?? "",
    process.env.CXX ?? "",
    process.env.PYTHON ?? "",
    process.env.npm_config_python ?? "",
  ].join("\0");
  if (cachedToolchainIdentity?.cacheKey === cacheKey) {
    return cachedToolchainIdentity.value;
  }
  const value = resolveToolchainIdentityUncached();
  cachedToolchainIdentity = { cacheKey, value };
  return value;
}

async function resolveToolchainIdentityUncached(): Promise<string> {
  const components = await Promise.all([
    toolVersion(process.env.CC ?? "cc", ["--version"]),
    toolVersion(process.env.CXX ?? "c++", ["--version"]),
    toolVersion("make", ["--version"]),
    toolVersion(
      process.env.npm_config_python ?? process.env.PYTHON ?? "python3",
      ["--version"],
    ),
  ]);
  return createHash("sha256")
    .update(
      [
        `platform=${platform()}`,
        `arch=${arch()}`,
        `osRelease=${release()}`,
        `CC=${process.env.CC ?? "cc"}`,
        `CXX=${process.env.CXX ?? "c++"}`,
        `PYTHON=${process.env.npm_config_python ?? process.env.PYTHON ?? "python3"}`,
        ...components,
      ].join("\n"),
    )
    .digest("hex");
}

async function toolVersion(
  command: string,
  args: readonly string[],
): Promise<string> {
  if (command.length === 0 || /\s/.test(command)) {
    return `${command}=unprobed`;
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: 5_000,
      maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    });
    return `${command}=${createHash("sha256")
      .update(stdout)
      .update(stderr)
      .digest("hex")}`;
  } catch (error) {
    const output = error as {
      readonly stdout?: string | Buffer;
      readonly stderr?: string | Buffer;
    };
    if (output.stdout !== undefined || output.stderr !== undefined) {
      return `${command}=${createHash("sha256")
        .update(output.stdout ?? "")
        .update(output.stderr ?? "")
        .digest("hex")}`;
    }
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return `${command}=unavailable:${code}`;
  }
}

function parseManifest(raw: string): PnpmNativeGenerationManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("dependency_pnpm_native_generation_manifest_invalid");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== PNPM_NATIVE_GENERATION_SCHEMA_VERSION ||
    typeof value.key !== "string" ||
    !isIdentity(value.identity) ||
    !isVerification(value.verification) ||
    !isStoreIntegrity(value.storeIntegrity)
  ) {
    throw new Error("dependency_pnpm_native_generation_manifest_invalid");
  }
  return {
    schemaVersion: PNPM_NATIVE_GENERATION_SCHEMA_VERSION,
    key: value.key,
    identity: value.identity,
    verification: value.verification,
    storeIntegrity: value.storeIntegrity,
  };
}

function isIdentity(value: unknown): value is PnpmNativeGenerationIdentity {
  return (
    isRecord(value) &&
    value.schemaVersion === PNPM_NATIVE_GENERATION_SCHEMA_VERSION &&
    typeof value.dependencyFingerprint === "string" &&
    typeof value.buildPolicyFingerprint === "string" &&
    typeof value.nodeVersion === "string" &&
    typeof value.nodeModulesAbi === "string" &&
    typeof value.platform === "string" &&
    typeof value.arch === "string" &&
    typeof value.pnpmVersion === "string" &&
    typeof value.libcIdentity === "string" &&
    typeof value.toolchainIdentity === "string"
  );
}

function isStoreIntegrity(value: unknown): value is PnpmNativeStoreIntegrity {
  return (
    isRecord(value) &&
    value.algorithm === "sha256" &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    Number.isSafeInteger(value.entryCount) &&
    (value.entryCount as number) >= 0 &&
    Number.isSafeInteger(value.fileCount) &&
    (value.fileCount as number) >= 0 &&
    Number.isSafeInteger(value.byteCount) &&
    (value.byteCount as number) >= 0
  );
}

function isVerification(
  value: unknown,
): value is PnpmNativeGenerationVerification {
  return (
    isRecord(value) &&
    typeof value.expectedAbi === "string" &&
    Number.isSafeInteger(value.inspectedAddonCount) &&
    (value.inspectedAddonCount as number) >= 0
  );
}

function sameIdentity(
  left: PnpmNativeGenerationIdentity,
  right: PnpmNativeGenerationIdentity,
): boolean {
  return pnpmNativeGenerationKey(left) === pnpmNativeGenerationKey(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}
