import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverDependencyLinksNative,
  discoverDependencyLinksWithNativeFind,
  discoverNativeAddonFilesWithNativeFind,
  NATIVE_DEPENDENCY_TRAVERSAL_POLICY,
} from "../dependency-native-traversal";
import { inspectNodeDependencyEnvironment } from "../dependency-environment-safety";

const roots: string[] = [];
const DEFAULT_LIMITS = {
  maxDependencyEntries: 250_000,
} as const;
let executableSequence = 0;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native dependency traversal policy", () => {
  it("keeps availability and resource bounds explicit", () => {
    expect(NATIVE_DEPENDENCY_TRAVERSAL_POLICY).toEqual({
      supportedPlatform: "linux",
      requiredFindVersionMarker: "GNU findutils",
      executableCandidates: ["/usr/bin/find", "/bin/find"],
      maxOutputBytes: 64 * 1024 * 1024,
      scanTimeoutMs: 60_000,
      probeTimeoutMs: 2_000,
    });
    expect(Object.isFrozen(NATIVE_DEPENDENCY_TRAVERSAL_POLICY)).toBe(true);
    expect(
      Object.isFrozen(NATIVE_DEPENDENCY_TRAVERSAL_POLICY.executableCandidates),
    ).toBe(true);
  });
});

describe.runIf(platform() !== "linux")(
  "native dependency traversal fallback",
  () => {
    it("reports native discovery unavailable outside the supported platform", async () => {
      const dependencyRoot = await createRoot(
        "subscription-runtime-native-platform-fallback-",
      );

      await expect(
        discoverDependencyLinksNative({
          dependencyRoot,
          limits: DEFAULT_LIMITS,
        }),
      ).resolves.toBeNull();
    });
  },
);

describe("native dependency traversal executable boundary", () => {
  it("passes exact GNU find arguments and preserves whitespace and newline paths through NUL records", async () => {
    const root = await createRoot("subscription-runtime-native-argv-");
    const dependencyRoot = join(root, "node modules\nroot");
    await mkdir(dependencyRoot, { recursive: true });
    const executablePath = await createExecutable(
      root,
      `
const root = process.argv[3];
const slash = String.fromCharCode(92);
const expected = [
  "-P", root, "-mindepth", "1", "(", "-type", "l",
  "-printf", "l%p" + slash + "0", ")", "-o",
  "-printf", "x" + slash + "0",
];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  process.exit(91);
}
for (const path of [root + "/safe path", root + "/line" + String.fromCharCode(10) + "break"]) {
  process.stdout.write(Buffer.from("l" + path));
  process.stdout.write(Buffer.from([0]));
}
process.stdout.write(Buffer.from([120, 0]));
`,
    );

    await expect(
      discoverDependencyLinksWithNativeFind({
        dependencyRoot,
        executablePath,
        limits: DEFAULT_LIMITS,
      }),
    ).resolves.toEqual([
      join(dependencyRoot, "safe path"),
      join(dependencyRoot, "line\nbreak"),
    ]);
  });

  it("discovers native addon files with exact bounded GNU find arguments", async () => {
    const root = await createRoot("subscription-runtime-native-addon-argv-");
    const dependencyRoot = join(root, "node modules");
    await mkdir(dependencyRoot, { recursive: true });
    const executablePath = await createExecutable(
      root,
      `
const root = process.argv[3];
const slash = String.fromCharCode(92);
const expected = [
  "-P", root, "-mindepth", "1", "(", "-type", "f", "-name", "*.node",
  "-printf", "n%p" + slash + "0", ")", "-o",
  "-printf", "x" + slash + "0",
];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  process.exit(91);
}
process.stdout.write(Buffer.from("n" + root + "/build/Release/addon.node"));
process.stdout.write(Buffer.from([0, 120, 0]));
`,
    );

    await expect(
      discoverNativeAddonFilesWithNativeFind({
        dependencyRoot,
        executablePath,
        limits: DEFAULT_LIMITS,
      }),
    ).resolves.toEqual([
      join(dependencyRoot, "build", "Release", "addon.node"),
    ]);
  });

  it("returns null only when the native executable disappears", async () => {
    const dependencyRoot = await createRoot(
      "subscription-runtime-native-missing-",
    );

    await expect(
      discoverDependencyLinksWithNativeFind({
        dependencyRoot,
        executablePath: join(dependencyRoot, "missing-find"),
        limits: DEFAULT_LIMITS,
      }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      name: "nonzero exit",
      body: `
process.stdout.write(Buffer.from([120, 0]));
process.exit(7);
`,
    },
    {
      name: "partial output",
      body: `
process.stdout.write(Buffer.from("l" + process.argv[3] + "/partial"));
`,
    },
  ])("fails closed on $name", async ({ body }) => {
    const dependencyRoot = await createRoot(
      "subscription-runtime-native-failure-",
    );
    const executablePath = await createExecutable(dependencyRoot, body);

    await expect(
      discoverDependencyLinksWithNativeFind({
        dependencyRoot,
        executablePath,
        limits: DEFAULT_LIMITS,
      }),
    ).rejects.toThrow("dependency_environment_native_scan_failed");
  });

  it("fails closed when native output reports a path outside the dependency root", async () => {
    const root = await createRoot("subscription-runtime-native-escape-");
    const dependencyRoot = join(root, "node_modules");
    await mkdir(dependencyRoot);
    const executablePath = await createExecutable(
      root,
      `
process.stdout.write(Buffer.from("l" + process.argv[3] + "/../escape"));
process.stdout.write(Buffer.from([0]));
`,
    );

    await expect(
      discoverDependencyLinksWithNativeFind({
        dependencyRoot,
        executablePath,
        limits: DEFAULT_LIMITS,
      }),
    ).rejects.toThrow("dependency_environment_native_scan_escape");
  });

  it("enforces the entry and output bounds", async () => {
    const dependencyRoot = await createRoot(
      "subscription-runtime-native-bounds-",
    );
    const executablePath = await createExecutable(
      dependencyRoot,
      `
for (let index = 0; index < 3; index += 1) {
  process.stdout.write(Buffer.from([120, 0]));
}
`,
    );

    await expect(
      discoverDependencyLinksWithNativeFind({
        dependencyRoot,
        executablePath,
        limits: { maxDependencyEntries: 1 },
      }),
    ).rejects.toThrow("dependency_environment_tree_scan_limit_exceeded");
    await expect(
      discoverDependencyLinksWithNativeFind({
        dependencyRoot,
        executablePath,
        limits: DEFAULT_LIMITS,
        runtimePolicy: {
          maxOutputBytes: 4,
          scanTimeoutMs: 60_000,
        },
      }),
    ).rejects.toThrow("dependency_environment_tree_scan_limit_exceeded");
  });

  it("enforces the traversal timeout", async () => {
    const dependencyRoot = await createRoot(
      "subscription-runtime-native-timeout-",
    );
    const executablePath = await createExecutable(
      dependencyRoot,
      "setInterval(() => {}, 1_000);",
    );

    await expect(
      discoverDependencyLinksWithNativeFind({
        dependencyRoot,
        executablePath,
        limits: DEFAULT_LIMITS,
        runtimePolicy: {
          maxOutputBytes: 1_024,
          scanTimeoutMs: 25,
        },
      }),
    ).rejects.toThrow("dependency_environment_native_scan_timeout");
  });
});

describe.runIf(platform() === "linux")(
  "GNU find dependency traversal integration",
  () => {
    it("uses the real native path without following dangling or escaping links", async () => {
      const root = await createRoot("subscription-runtime-native-linux-");
      const workspacePath = join(root, "workspace path\nline");
      const dependencyRoot = join(workspacePath, "node_modules");
      const safeTarget = join(dependencyRoot, ".pnpm", "safe target\nline");
      const outsidePath = join(root, "outside");
      await Promise.all([
        mkdir(safeTarget, { recursive: true }),
        mkdir(outsidePath, { recursive: true }),
      ]);
      await symlink(
        "missing nested target",
        join(outsidePath, "nested link"),
        "dir",
      );
      const safeLink = join(dependencyRoot, "safe link\nline");
      const danglingLink = join(dependencyRoot, "dangling link\nline");
      const escapingLink = join(dependencyRoot, "escaping link\nline");
      const expectedLinks = [safeLink, danglingLink, escapingLink];
      await Promise.all([
        symlink(".pnpm/safe target\nline", safeLink, "dir"),
        symlink("missing target\nline", danglingLink, "dir"),
        symlink(outsidePath, escapingLink, "dir"),
      ]);

      const links = await discoverDependencyLinksNative({
        dependencyRoot,
        limits: DEFAULT_LIMITS,
      });
      expect(links).not.toBeNull();
      expect([...(links ?? [])].sort()).toEqual([...expectedLinks].sort());
      await expect(
        inspectNodeDependencyEnvironment({ workspacePath }),
      ).resolves.toEqual({
        dependencyRoots: ["node_modules"],
        unsafeDependencyRoots: ["node_modules"],
      });
    });
  },
);

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createExecutable(root: string, body: string): Promise<string> {
  executableSequence += 1;
  const executablePath = join(root, `fake-find-${executableSequence}.mjs`);
  await writeFile(executablePath, `#!${process.execPath}\n${body}\n`);
  await chmod(executablePath, 0o755);
  return executablePath;
}
