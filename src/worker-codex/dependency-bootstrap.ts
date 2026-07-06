import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DependencyBootstrapMode = "off" | "preflight" | "install";

export type DependencyPackageManagerName = "pnpm" | "npm" | "yarn" | "bun";

export type DependencyPackageManager = {
  readonly name: DependencyPackageManagerName;
  readonly source: "lockfile" | "packageManager" | "fallback";
  readonly versionSpec?: string;
  readonly lockfilePath?: string;
};

export type DependencyBinaryCheck = {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
};

export type DependencyPreflightResult = {
  readonly mode: DependencyBootstrapMode;
  readonly workspacePath: string;
  readonly packageJsonPath?: string;
  readonly packageManager?: DependencyPackageManager;
  readonly nodeModulesPath: string;
  readonly nodeModulesExists: boolean;
  readonly binaryChecks: readonly DependencyBinaryCheck[];
  readonly fingerprint?: string;
  readonly fingerprintInputs: readonly string[];
  readonly installCommand?: string;
  readonly cacheRoot?: string;
  readonly diagnosticPath?: string;
  readonly status:
    | "off"
    | "not_node_project"
    | "ready"
    | "deps_missing"
    | "installed"
    | "install_failed";
  readonly warnings: readonly string[];
};

export type DependencyBootstrapInput = {
  readonly workspacePath: string;
  readonly jobRootDir?: string;
  readonly cacheRoot?: string;
  readonly mode?: DependencyBootstrapMode;
  readonly confirmInstall?: boolean;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs: number },
  ) => Promise<void>;
};

export async function runDependencyBootstrap(
  input: DependencyBootstrapInput,
): Promise<DependencyPreflightResult> {
  const mode = input.mode ?? "preflight";
  const preflight = await inspectDependencyBootstrap(input.workspacePath, mode);
  const cacheRoot = input.cacheRoot ?? defaultDependencyCacheRoot(input);
  let withCommand = attachInstallCommand(preflight, cacheRoot);

  if (input.jobRootDir) {
    const diagnosticPath = await writeDependencyPreflightDiagnostic(
      input.jobRootDir,
      withCommand,
    );
    withCommand = { ...withCommand, diagnosticPath };
  }
  if (mode !== "install" || !withCommand.packageManager) return withCommand;
  if (!input.confirmInstall) {
    return {
      ...withCommand,
      status: "install_failed",
      warnings: [
        ...withCommand.warnings,
        "dependency_install_requires_confirmDependencyBootstrap",
      ],
    };
  }

  try {
    await runPackageManagerInstall({
      workspacePath: input.workspacePath,
      packageManager: withCommand.packageManager,
      ...(cacheRoot ? { cacheRoot } : {}),
      ...(input.runCommand ? { runCommand: input.runCommand } : {}),
    });
    const installed = await inspectDependencyBootstrap(input.workspacePath, mode);
    let result = attachInstallCommand({
      ...installed,
      status: "installed",
    }, cacheRoot);
    if (input.jobRootDir) {
      const diagnosticPath = await writeDependencyPreflightDiagnostic(input.jobRootDir, result);
      result = { ...result, diagnosticPath };
    }
    return result;
  } catch (error) {
    let result: DependencyPreflightResult = {
      ...withCommand,
      status: "install_failed",
      warnings: [
        ...withCommand.warnings,
        `dependency_install_failed:${safeErrorMessage(error)}`,
      ],
    };
    if (input.jobRootDir) {
      const diagnosticPath = await writeDependencyPreflightDiagnostic(input.jobRootDir, result);
      result = { ...result, diagnosticPath };
    }
    return result;
  }
}

export async function inspectDependencyBootstrap(
  workspacePath: string,
  mode: DependencyBootstrapMode = "preflight",
): Promise<DependencyPreflightResult> {
  if (mode === "off") {
    return baseResult(workspacePath, mode, "off");
  }
  const packageJsonPath = join(workspacePath, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return baseResult(workspacePath, mode, "not_node_project");
  }

  const packageJson = await readPackageJson(packageJsonPath);
  const packageManager = await detectPackageManager(workspacePath, packageJson);
  const fingerprintInputs = await dependencyFingerprintInputs({
    workspacePath,
    packageJsonPath,
    packageManager,
  });
  const fingerprint = hashStrings(fingerprintInputs);
  const nodeModulesPath = join(workspacePath, "node_modules");
  const nodeModulesExists = await pathExists(nodeModulesPath);
  const binaryChecks = await dependencyBinaryChecks(workspacePath, packageJson);

  return {
    mode,
    workspacePath,
    packageJsonPath,
    packageManager,
    nodeModulesPath,
    nodeModulesExists,
    binaryChecks,
    fingerprint,
    fingerprintInputs,
    status: nodeModulesExists ? "ready" : "deps_missing",
    warnings: nodeModulesExists ? [] : ["node_modules_missing"],
  };
}

export function defaultDependencyCacheRoot(input: {
  readonly workspacePath: string;
  readonly jobRootDir?: string;
  readonly cacheRoot?: string;
}): string | undefined {
  if (input.cacheRoot) return input.cacheRoot;
  if (!input.jobRootDir) return undefined;
  return join(dirname(input.jobRootDir), ".dependency-cache");
}

async function runPackageManagerInstall(input: {
  readonly workspacePath: string;
  readonly packageManager: DependencyPackageManager;
  readonly cacheRoot?: string;
  readonly runCommand?: DependencyBootstrapInput["runCommand"];
}): Promise<void> {
  const commands = packageManagerInstallCommands(input.packageManager, input.cacheRoot);
  const runCommand = input.runCommand ?? defaultRunCommand;
  if (input.cacheRoot) {
    await mkdir(input.cacheRoot, { recursive: true, mode: 0o700 });
  }
  for (const command of commands) {
    await runCommand(command[0] ?? "", command.slice(1), {
      cwd: input.workspacePath,
      timeoutMs: 120_000,
    });
  }
}

function attachInstallCommand(
  result: DependencyPreflightResult,
  cacheRoot: string | undefined,
): DependencyPreflightResult {
  if (!result.packageManager) return result;
  return {
    ...result,
    ...(cacheRoot ? { cacheRoot } : {}),
    installCommand: packageManagerInstallCommands(result.packageManager, cacheRoot)
      .map((command) => command.join(" "))
      .join(" && "),
  };
}

function packageManagerInstallCommands(
  packageManager: DependencyPackageManager,
  cacheRoot: string | undefined,
): readonly (readonly string[])[] {
  switch (packageManager.name) {
    case "pnpm": {
      const storeArgs = cacheRoot ? ["--store-dir", join(cacheRoot, "pnpm-store")] : [];
      return [
        ["pnpm", "fetch", "--frozen-lockfile", ...storeArgs],
        ["pnpm", "install", "--offline", "--frozen-lockfile", ...storeArgs],
      ];
    }
    case "npm":
      return [[
        "npm",
        "ci",
        "--prefer-offline",
        ...(cacheRoot ? ["--cache", join(cacheRoot, "npm-cache")] : []),
      ]];
    case "yarn":
      return [[
        "yarn",
        "install",
        "--frozen-lockfile",
        ...(cacheRoot ? ["--cache-folder", join(cacheRoot, "yarn-cache")] : []),
      ]];
    case "bun":
      return [[
        "bun",
        "install",
        "--frozen-lockfile",
        ...(cacheRoot ? ["--cache-dir", join(cacheRoot, "bun-cache")] : []),
      ]];
  }
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<void> {
  await execFileAsync(command, [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
    },
  });
}

async function detectPackageManager(
  workspacePath: string,
  packageJson: Record<string, unknown>,
): Promise<DependencyPackageManager> {
  const packageManagerSpec = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager
    : undefined;
  const packageManagerName = packageManagerSpec?.split("@")[0];
  if (isPackageManagerName(packageManagerName)) {
    return {
      name: packageManagerName,
      source: "packageManager",
      ...(packageManagerSpec ? { versionSpec: packageManagerSpec } : {}),
      ...(await lockfileForPackageManager(workspacePath, packageManagerName)),
    };
  }

  for (const candidate of [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ] as const) {
    const lockfilePath = join(workspacePath, candidate[0]);
    if (await pathExists(lockfilePath)) {
      return {
        name: candidate[1],
        source: "lockfile",
        lockfilePath,
      };
    }
  }
  return { name: "npm", source: "fallback" };
}

async function lockfileForPackageManager(
  workspacePath: string,
  name: DependencyPackageManagerName,
): Promise<Pick<DependencyPackageManager, "lockfilePath">> {
  const lockfiles: Record<DependencyPackageManagerName, readonly string[]> = {
    pnpm: ["pnpm-lock.yaml"],
    npm: ["package-lock.json", "npm-shrinkwrap.json"],
    yarn: ["yarn.lock"],
    bun: ["bun.lockb", "bun.lock"],
  };
  for (const lockfile of lockfiles[name]) {
    const lockfilePath = join(workspacePath, lockfile);
    if (await pathExists(lockfilePath)) return { lockfilePath };
  }
  return {};
}

async function dependencyFingerprintInputs(input: {
  readonly workspacePath: string;
  readonly packageJsonPath: string;
  readonly packageManager: DependencyPackageManager;
}): Promise<readonly string[]> {
  const inputs = [
    `node=${process.versions.node}`,
    `platform=${platform()}`,
    `arch=${arch()}`,
    `packageManager=${input.packageManager.name}`,
    `packageManagerSource=${input.packageManager.source}`,
    input.packageManager.versionSpec
      ? `packageManagerSpec=${input.packageManager.versionSpec}`
      : undefined,
    `package.json=${await fileHash(input.packageJsonPath)}`,
  ].filter((value): value is string => Boolean(value));
  if (input.packageManager.lockfilePath) {
    return [
      ...inputs,
      `${basename(input.packageManager.lockfilePath)}=${
        await fileHash(input.packageManager.lockfilePath)
      }`,
    ];
  }
  return inputs;
}

async function dependencyBinaryChecks(
  workspacePath: string,
  packageJson: Record<string, unknown>,
): Promise<readonly DependencyBinaryCheck[]> {
  const scripts = typeof packageJson.scripts === "object" && packageJson.scripts !== null
    ? packageJson.scripts as Record<string, unknown>
    : {};
  const names = new Set<string>(["tsc"]);
  if (typeof scripts.test === "string") names.add("vitest");
  if (typeof scripts.lint === "string") names.add("eslint");
  const binDir = join(workspacePath, "node_modules", ".bin");
  return Promise.all([...names].sort().map(async (name) => {
    const path = join(binDir, name);
    return {
      name,
      path,
      exists: await pathExists(path),
    };
  }));
}

async function writeDependencyPreflightDiagnostic(
  jobRootDir: string,
  result: DependencyPreflightResult,
): Promise<string> {
  await mkdir(jobRootDir, { recursive: true, mode: 0o700 });
  const diagnosticPath = join(jobRootDir, "dependency-preflight.json");
  await writeFile(diagnosticPath, `${JSON.stringify({
    ...result,
    diagnosticPath,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return diagnosticPath;
}

async function readPackageJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function hashStrings(values: readonly string[]): string {
  return createHash("sha256")
    .update(values.join("\n"))
    .digest("hex");
}

function isPackageManagerName(
  value: string | undefined,
): value is DependencyPackageManagerName {
  return value === "pnpm" || value === "npm" || value === "yarn" || value === "bun";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function baseResult(
  workspacePath: string,
  mode: DependencyBootstrapMode,
  status: DependencyPreflightResult["status"],
): DependencyPreflightResult {
  return {
    mode,
    workspacePath,
    nodeModulesPath: join(workspacePath, "node_modules"),
    nodeModulesExists: false,
    binaryChecks: [],
    fingerprintInputs: [],
    status,
    warnings: [],
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
