import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDependencyBootstrap } from "../dependency-bootstrap";
import {
  pnpmNativeGenerationKey,
  type PnpmNativeGenerationIdentity,
} from "../dependency-pnpm-side-effects-cache";
import { inspectNativeAddonCompatibility } from "../native-addon-compatibility";

describe("pnpm verified side-effects cache", () => {
  it("reuses one verified generation without a second native rebuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnpm-native-generation-hit-"));
    const cacheRoot = join(root, "cache");
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    const commands: string[][] = [];
    try {
      await Promise.all([
        writeFixture(firstWorkspace),
        writeFixture(secondWorkspace),
      ]);

      const runCommand = async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string },
      ) => {
        commands.push([command, ...args]);
        if (command === "pnpm" && args[0] === "install") {
          await materializeAddon(
            options.cwd,
            args.includes("--config.side-effects-cache-readonly=true")
              ? process.versions.modules
              : "999",
          );
        }
        if (command === "pnpm" && args[0] === "rebuild") {
          await materializeAddon(options.cwd, process.versions.modules);
        }
      };

      const first = await runDependencyBootstrap({
        workspacePath: firstWorkspace,
        cacheRoot,
        mode: "install",
        confirmInstall: true,
        runCommand,
      });
      const second = await runDependencyBootstrap({
        workspacePath: secondWorkspace,
        cacheRoot,
        mode: "install",
        confirmInstall: true,
        runCommand,
      });

      expect(first.status, first.warnings.join("\n")).toBe("installed");
      expect(second.status, second.warnings.join("\n")).toBe("installed");
      expect(
        commands.filter(
          ([command, subcommand]) =>
            command === "pnpm" && subcommand === "fetch",
        ),
      ).toHaveLength(1);
      expect(
        commands.filter(
          ([command, subcommand]) =>
            command === "pnpm" && subcommand === "rebuild",
        ),
      ).toHaveLength(1);
      expect(
        commands.some((command) =>
          command.includes("--config.side-effects-cache-readonly=true"),
        ),
      ).toBe(true);
      const nodeVerification = commands.find(
        ([command]) => command === process.execPath,
      );
      expect(nodeVerification?.slice(0, 3)).toEqual([
        process.execPath,
        "-e",
        expect.stringContaining("process.dlopen"),
      ]);
      expect(JSON.parse(nodeVerification?.[3] ?? "[]")).toHaveLength(1);

      const keys = await publishedGenerationKeys(cacheRoot);
      expect(keys).toHaveLength(1);
      const manifest = JSON.parse(
        await readFile(
          join(
            cacheRoot,
            "pnpm-native-generations",
            keys[0] ?? "",
            "manifest.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        schemaVersion: 2,
        key: keys[0],
        verification: {
          expectedAbi: process.versions.modules,
          inspectedAddonCount: 1,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates the generation key for every runtime identity dimension", () => {
    const base: PnpmNativeGenerationIdentity = {
      schemaVersion: 2,
      dependencyFingerprint: "a".repeat(64),
      buildPolicyFingerprint: "c".repeat(64),
      nodeVersion: "24.4.1",
      nodeModulesAbi: "137",
      platform: "linux",
      arch: "x64",
      pnpmVersion: "10.33.4",
      libcIdentity: "glibc-2.39",
      toolchainIdentity: "clang-20",
    };
    const identities: readonly PnpmNativeGenerationIdentity[] = [
      base,
      { ...base, schemaVersion: 3 as 2 },
      { ...base, dependencyFingerprint: "b".repeat(64) },
      { ...base, buildPolicyFingerprint: "d".repeat(64) },
      { ...base, nodeVersion: "24.4.2" },
      { ...base, nodeModulesAbi: "138" },
      { ...base, platform: "darwin" },
      { ...base, arch: "arm64" },
      { ...base, pnpmVersion: "10.34.0" },
      { ...base, libcIdentity: "musl-1.2.5" },
      { ...base, toolchainIdentity: "gcc-15" },
    ];

    expect(new Set(identities.map(pnpmNativeGenerationKey)).size).toBe(
      identities.length,
    );
  });

  it("does not publish a generation when native validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnpm-native-generation-fail-"));
    const cacheRoot = join(root, "cache");
    const workspace = join(root, "workspace");
    try {
      await writeFixture(workspace);
      const result = await runDependencyBootstrap({
        workspacePath: workspace,
        cacheRoot,
        mode: "install",
        confirmInstall: true,
        runCommand: async (command, args, options) => {
          if (command === "pnpm" && args[0] === "install") {
            await materializeAddon(options.cwd, "999");
          }
        },
      });

      expect(result.status).toBe("install_failed");
      expect(result.warnings).toContain(
        `dependency_install_failed:dependency_native_addon_abi_mismatch:${process.versions.modules}`,
      );
      expect(await publishedGenerationKeys(cacheRoot)).toEqual([]);
      expect(await stagingGenerationKeys(cacheRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked store entry before publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnpm-native-store-link-"));
    const cacheRoot = join(root, "cache");
    const workspace = join(root, "workspace");
    try {
      await writeFixture(workspace);
      const result = await runDependencyBootstrap({
        workspacePath: workspace,
        cacheRoot,
        mode: "install",
        confirmInstall: true,
        runCommand: async (command, args, options) => {
          if (command === "pnpm" && args[0] === "fetch") {
            const storeIndex = args.indexOf("--store-dir");
            const storePath = args[storeIndex + 1] ?? "";
            await symlink(join(root, "outside"), join(storePath, "escape"));
          }
          if (command === "pnpm" && args[0] === "install") {
            await materializeAddon(options.cwd, process.versions.modules);
          }
        },
      });
      expect(result.status).toBe("install_failed");
      expect(result.warnings).toContain(
        "dependency_install_failed:dependency_pnpm_native_generation_store_symlink",
      );
      expect(await publishedGenerationKeys(cacheRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent cold workspaces and publishes only after verification", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "pnpm-native-generation-concurrent-"),
    );
    const cacheRoot = join(root, "cache");
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    let fetchCount = 0;
    let rebuildCount = 0;
    try {
      await Promise.all([
        writeFixture(firstWorkspace),
        writeFixture(secondWorkspace),
      ]);
      const runCommand = async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string },
      ) => {
        if (command === "pnpm" && args[0] === "fetch") fetchCount += 1;
        if (command === "pnpm" && args[0] === "install") {
          await materializeAddon(
            options.cwd,
            args.includes("--config.side-effects-cache-readonly=true")
              ? process.versions.modules
              : "999",
          );
        }
        if (command === "pnpm" && args[0] === "rebuild") {
          rebuildCount += 1;
          expect(await publishedGenerationKeys(cacheRoot)).toEqual([]);
          await delay(40);
          await materializeAddon(options.cwd, process.versions.modules);
        }
      };

      const [first, second] = await Promise.all([
        runDependencyBootstrap({
          workspacePath: firstWorkspace,
          cacheRoot,
          mode: "install",
          confirmInstall: true,
          runCommand,
        }),
        runDependencyBootstrap({
          workspacePath: secondWorkspace,
          cacheRoot,
          mode: "install",
          confirmInstall: true,
          runCommand,
        }),
      ]);

      expect([first.status, second.status]).toEqual([
        "installed",
        "installed",
      ]);
      expect(fetchCount).toBe(1);
      expect(rebuildCount).toBe(1);
      expect(await publishedGenerationKeys(cacheRoot)).toHaveLength(1);
      expect(await stagingGenerationKeys(cacheRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quarantines a tampered generation and rebuilds it under the cache lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnpm-native-tamper-"));
    const cacheRoot = join(root, "cache");
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    let fetchCount = 0;
    try {
      await Promise.all([
        writeFixture(firstWorkspace),
        writeFixture(secondWorkspace),
      ]);
      const runCommand = async (
        command: string,
        args: readonly string[],
        options: { readonly cwd: string },
      ) => {
        if (command === "pnpm" && args[0] === "fetch") fetchCount += 1;
        if (command === "pnpm" && args[0] === "install") {
          await materializeAddon(options.cwd, process.versions.modules);
        }
      };
      expect(
        (
          await runDependencyBootstrap({
            workspacePath: firstWorkspace,
            cacheRoot,
            mode: "install",
            confirmInstall: true,
            runCommand,
          })
        ).status,
      ).toBe("installed");
      const [key] = await publishedGenerationKeys(cacheRoot);
      await writeFile(
        join(
          cacheRoot,
          "pnpm-native-generations",
          key ?? "",
          "store",
          "tampered",
        ),
        "unexpected",
      );

      expect(
        (
          await runDependencyBootstrap({
            workspacePath: secondWorkspace,
            cacheRoot,
            mode: "install",
            confirmInstall: true,
            runCommand,
          })
        ).status,
      ).toBe("installed");
      expect(fetchCount).toBe(2);
      expect(
        await directoryNames(
          join(cacheRoot, "pnpm-native-generations", ".quarantine"),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inspects prebuild and lib binding addons, not only node-gyp output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnpm-native-all-layouts-"));
    try {
      await writeFixture(root);
      const packageRoot = join(
        root,
        "node_modules",
        ".pnpm",
        "native-addon@1.0.0",
        "node_modules",
        "native-addon",
      );
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "native-addon" }),
      );
      for (const relativePath of [
        ["build", "Release", "build.node"],
        ["prebuilds", "linux-x64", "prebuild.node"],
        ["lib", "binding", "node-v137-linux-x64", "binding.node"],
      ]) {
        const addonPath = join(packageRoot, ...relativePath);
        await mkdir(join(addonPath, ".."), { recursive: true });
        await writeFile(
          addonPath,
          `node_register_module_v${process.versions.modules}`,
        );
      }
      const compatibility = await inspectNativeAddonCompatibility(root);
      expect(compatibility.inspectedAddonCount).toBe(3);
      expect(compatibility.inspectedAddonPaths).toEqual(
        expect.arrayContaining([
          expect.stringContaining("prebuild.node"),
          expect.stringContaining("binding.node"),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFixture(workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  await Promise.all([
    writeFile(
      join(workspacePath, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.33.4" }),
    ),
    writeFile(
      join(workspacePath, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    ),
  ]);
}

async function materializeAddon(
  workspacePath: string,
  abi: string | undefined,
): Promise<void> {
  const packageRoot = join(
    workspacePath,
    "node_modules",
    ".pnpm",
    "native-addon@1.0.0",
    "node_modules",
    "native-addon",
  );
  const addonPath = join(
    packageRoot,
    "build",
    "Release",
    "native-addon.node",
  );
  await Promise.all([
    mkdir(join(workspacePath, "node_modules", ".bin"), { recursive: true }),
    mkdir(join(addonPath, ".."), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "native-addon", version: "1.0.0" }),
    ),
    writeFile(addonPath, `node_register_module_v${abi ?? "unavailable"}`),
  ]);
}

async function publishedGenerationKeys(
  cacheRoot: string,
): Promise<readonly string[]> {
  return directoryNames(join(cacheRoot, "pnpm-native-generations"), [
    ".staging",
    ".quarantine",
  ]);
}

async function stagingGenerationKeys(
  cacheRoot: string,
): Promise<readonly string[]> {
  return directoryNames(
    join(cacheRoot, "pnpm-native-generations", ".staging"),
  );
}

async function directoryNames(
  path: string,
  excluded: readonly string[] = [],
): Promise<readonly string[]> {
  try {
    return (await readdir(path))
      .filter((name) => !excluded.includes(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
