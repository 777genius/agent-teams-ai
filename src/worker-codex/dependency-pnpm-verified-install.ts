import { sanitizeNodeDependencyEnvironment } from "./dependency-environment-safety";
import { withDependencyBootstrapWorkspaceTransaction } from "./dependency-bootstrap-workspace-transaction";
import {
  inspectNativeAddonCompatibility,
  isRuntimeCompatibleNativeAddonPath,
  resolveNativeAddonHeaderRoot,
} from "./native-addon-compatibility";
import {
  createStagedPnpmNativeGeneration,
  findVerifiedPnpmNativeGeneration,
  publishStagedPnpmNativeGeneration,
  removePnpmStoreProjectRegistryLinks,
  removeStagedPnpmNativeGeneration,
  resolvePnpmNativeGenerationIdentity,
  type StagedPnpmNativeGeneration,
} from "./dependency-pnpm-side-effects-cache";

const NATIVE_ADDON_VERIFICATION_BATCH_BYTES = 48 * 1024;
const NATIVE_ADDON_VERIFICATION_SCRIPT =
  "const paths=JSON.parse(process.argv[1]);for(const path of paths){const module={exports:{},filename:path,paths:[]};process.dlopen(module,path)}";

type DependencyCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly env?: Readonly<Record<string, string>>;
  },
) => Promise<void>;

export async function runPnpmInstallWithVerifiedSideEffectsCache(input: {
  readonly workspacePath: string;
  readonly packageManagerVersionSpec?: string;
  readonly dependencyFingerprint: string;
  readonly cacheRoot: string;
  readonly runCommand: DependencyCommandRunner;
  readonly commandIsInjected?: boolean;
  readonly nodeExecutablePath?: string;
}): Promise<{
  readonly sanitizedDependencyPaths: readonly string[];
  readonly nativeAddonAbi: string;
  readonly nativeAddonCount: number;
  readonly nativeAddonRepairAttempted?: boolean;
}> {
  const identity = await resolvePnpmNativeGenerationIdentity({
    workspacePath: input.workspacePath,
    dependencyFingerprint: input.dependencyFingerprint,
    ...(input.packageManagerVersionSpec
      ? { packageManagerVersionSpec: input.packageManagerVersionSpec }
      : {}),
    ...(input.nodeExecutablePath
      ? { nodeExecutablePath: input.nodeExecutablePath }
      : {}),
    commandIsInjected: input.commandIsInjected ?? false,
  });
  const existing = await findVerifiedPnpmNativeGeneration(
    input.cacheRoot,
    identity,
  );
  let staged: StagedPnpmNativeGeneration | undefined;
  try {
    if (!existing) {
      staged = await createStagedPnpmNativeGeneration(
        input.cacheRoot,
        identity,
      );
    }
    const storePath = existing?.storePath ?? staged?.storePath;
    if (!storePath) {
      throw new Error("dependency_pnpm_native_generation_store_unavailable");
    }
    const headerRoot = await resolveNativeAddonHeaderRoot(
      input.nodeExecutablePath,
    );
    const result = await withDependencyBootstrapWorkspaceTransaction({
      workspacePath: input.workspacePath,
      action: async () => {
        const sanitized = await sanitizeNodeDependencyEnvironment({
          workspacePath: input.workspacePath,
        });
        const commands = existing
          ? [
              [
                "pnpm",
                "install",
                "--offline",
                "--frozen-lockfile",
                "--config.side-effects-cache=true",
                "--config.side-effects-cache-readonly=true",
                "--store-dir",
                storePath,
              ],
            ]
          : [
              [
                "pnpm",
                "fetch",
                "--frozen-lockfile",
                "--config.side-effects-cache=true",
                "--store-dir",
                storePath,
              ],
              [
                "pnpm",
                "install",
                "--offline",
                "--frozen-lockfile",
                "--config.side-effects-cache=true",
                "--store-dir",
                storePath,
              ],
            ];
        for (const command of commands) {
          await input.runCommand(command[0] ?? "", command.slice(1), {
            cwd: input.workspacePath,
            timeoutMs: 120_000,
            ...(headerRoot && command[1] !== "fetch"
              ? { env: { npm_config_nodedir: headerRoot } }
              : {}),
          });
        }

        let compatibility = await inspectNativeAddonCompatibility(
          input.workspacePath,
          identity.nodeModulesAbi,
          {
            platform: identity.platform,
            arch: identity.arch,
            abi: identity.nodeModulesAbi,
          },
        );
        if (
          existing &&
          compatibility.inspectedAddonCount !==
            existing.verification.inspectedAddonCount
        ) {
          throw new Error(
            "dependency_pnpm_native_generation_verification_mismatch",
          );
        }
        let nativeAddonRepairAttempted = false;
        if (compatibility.incompatibleAddonCount > 0) {
          await input.runCommand(
            "pnpm",
            [
              "rebuild",
              `--config.side-effects-cache=${existing ? "false" : "true"}`,
              "--store-dir",
              storePath,
              ...compatibility.incompatiblePackageNames,
            ],
            {
              cwd: input.workspacePath,
              timeoutMs: 120_000,
              ...(headerRoot
                ? { env: { npm_config_nodedir: headerRoot } }
                : {}),
            },
          );
          compatibility = await inspectNativeAddonCompatibility(
            input.workspacePath,
            identity.nodeModulesAbi,
            {
              platform: identity.platform,
              arch: identity.arch,
              abi: identity.nodeModulesAbi,
            },
          );
          if (compatibility.incompatibleAddonCount > 0) {
            throw new Error(
              `dependency_native_addon_abi_mismatch:${compatibility.expectedAbi}`,
            );
          }
          nativeAddonRepairAttempted = true;
        }
        await verifyNativeAddonsUnderTargetNode({
          addonPaths: compatibility.inspectedAddonPaths,
          nodeExecutablePath: input.nodeExecutablePath ?? process.execPath,
          runtimePlatform: identity.platform,
          runtimeArch: identity.arch,
          runtimeAbi: identity.nodeModulesAbi,
          workspacePath: input.workspacePath,
          runCommand: input.runCommand,
        });
        return {
          sanitizedDependencyPaths: sanitized.removedPaths,
          nativeAddonAbi: compatibility.expectedAbi,
          nativeAddonCount: compatibility.inspectedAddonCount,
          ...(nativeAddonRepairAttempted
            ? { nativeAddonRepairAttempted: true }
            : {}),
        };
      },
    });

    if (staged) {
      await publishStagedPnpmNativeGeneration({
        cacheRoot: input.cacheRoot,
        identity,
        staged,
        verification: {
          expectedAbi: result.nativeAddonAbi,
          inspectedAddonCount: result.nativeAddonCount,
        },
      });
    }
    return result;
  } finally {
    if (existing) {
      await removePnpmStoreProjectRegistryLinks(existing.storePath);
    }
    if (staged) {
      await removeStagedPnpmNativeGeneration(staged);
    }
  }
}

async function verifyNativeAddonsUnderTargetNode(input: {
  readonly addonPaths: readonly string[];
  readonly nodeExecutablePath: string;
  readonly runtimePlatform: string;
  readonly runtimeArch: string;
  readonly runtimeAbi: string;
  readonly workspacePath: string;
  readonly runCommand: DependencyCommandRunner;
}): Promise<void> {
  let batch: string[] = [];
  let batchBytes = 2;
  const verifyBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    await input.runCommand(
      input.nodeExecutablePath,
      ["-e", NATIVE_ADDON_VERIFICATION_SCRIPT, JSON.stringify(batch)],
      { cwd: input.workspacePath, timeoutMs: 30_000 },
    );
    batch = [];
    batchBytes = 2;
  };
  for (const addonPath of input.addonPaths) {
    if (
      !isRuntimeCompatibleNativeAddonPath(addonPath, {
        platform: input.runtimePlatform,
        arch: input.runtimeArch,
        abi: input.runtimeAbi,
      })
    ) {
      continue;
    }
    const encodedBytes = Buffer.byteLength(JSON.stringify(addonPath), "utf8");
    if (
      batch.length > 0 &&
      batchBytes + encodedBytes + 1 > NATIVE_ADDON_VERIFICATION_BATCH_BYTES
    ) {
      await verifyBatch();
    }
    batch.push(addonPath);
    batchBytes += encodedBytes + 1;
  }
  await verifyBatch();
}
