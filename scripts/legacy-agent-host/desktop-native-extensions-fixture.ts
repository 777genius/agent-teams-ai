import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { captureNativeClaudeFile } from "../../packages/legacy-agent-host/dist/extensions/captureNativeClaudeFile.js";
import {
  desktopBackendEnvironment,
  digest,
  fileDigest,
} from "./desktop-backend-fixture.ts";
import type { prepareDesktopBackendFixture } from "./desktop-backend-fixture.ts";
import type { TeamHostProfile } from "../../packages/legacy-agent-host/dist/composition/TeamHost.js";
import type { ClaudeManagementProfile } from "../../packages/legacy-agent-host/dist/management/profile.js";

type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
export const extensionPlugin = "frontend-design@claude-plugins-official";
export const extensionMcpName = "context7";
export const extensionMcpUrl =
  "http://127.0.0.1:9/TEST-native-extension-config-only";
export interface NativeExtensionProofSelection {
  profile: ClaudeManagementProfile;
  setup: {
    command: string[];
    outcome: "observed-exit-0";
    outputSha256: string;
  }[];
  plugin: string;
  nativeConfig: string;
  neighborPath: string;
  neighborSha256: string;
}

/** Original pinned native CLI, explicit TEST environment, no shell or ambient credential inheritance. */
export function extensionNativeCli(
  profile: ClaudeManagementProfile,
  args: readonly string[],
): string {
  assert.equal(
    process.env.LEGACY_DESKTOP_BACKEND_GO,
    "1",
    "Root GO before native CLI effects",
  );
  return execFileSync(profile.executable.path, [...args], {
    cwd: profile.cwd,
    env: { ...profile.environment },
    timeout: 180_000,
    encoding: "utf8",
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Overlay only this issuer's fresh TEST fixture. Marketplace setup is an actual native CLI action. */
export async function prepareDesktopNativeExtensionsFixture(
  fixture: Fixture,
): Promise<Fixture> {
  assert.equal(process.env.LEGACY_DESKTOP_BACKEND_GO, "1");
  assert.ok(basename(fixture.root).startsWith("TEST-desktop-backend-"));
  assert.equal(await realpath(fixture.root), fixture.root);
  const executable = await realpath(process.env.LEGACY_DESKTOP_CLAUDE_PATH!);
  const sha256 = await fileDigest(executable);
  assert.equal(
    sha256,
    "ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f",
  );
  const selected = join(fixture.root, "native-extensions");
  for (const path of [
    selected,
    join(selected, "home"),
    join(selected, "config"),
    join(selected, "tmp"),
    join(selected, "neighbor"),
  ])
    await mkdir(path, { mode: 0o700 });
  const neighborPath = join(selected, "neighbor", ".claude.json");
  await writeFile(
    neighborPath,
    JSON.stringify({ TEST_neighbor_must_remain_unchanged: true }),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  const profile: ClaudeManagementProfile = {
    provider: "claude",
    sdkRevision: "0.3.305",
    profileId: "TEST-native-extensions",
    accountBinding: "TEST-no-vendor-account",
    configRevision: "TEST-native-extensions-v1",
    configNamespace: "custom-directory",
    cwd: join(fixture.root, "workspace"),
    executable: { path: executable, sha256 },
    timeoutMs: 15_000,
    environment: {
      HOME: join(selected, "home"),
      CLAUDE_CONFIG_DIR: join(selected, "config"),
      TMPDIR: join(selected, "tmp"),
      PATH: dirname(fixture.node) + ":/usr/bin:/bin",
      SHELL: "/bin/sh",
      ANTHROPIC_API_KEY: "TEST-LOCALHOST-ONLY",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      NO_COLOR: "1",
    },
  };
  const setup: NativeExtensionProofSelection["setup"] = [];
  const args = [
    "plugin",
    "marketplace",
    "add",
    "https://github.com/anthropics/claude-plugins-official.git",
  ];
  // One planned setup action; an uncertain command fails this attempt without replay.
  const output = extensionNativeCli(profile, args);
  setup.push({
    command: args,
    outcome: "observed-exit-0",
    outputSha256: digest(output),
  });
  const hostProfile = JSON.parse(
    await readFile(fixture.profilePath, "utf8"),
  ) as TeamHostProfile;
  hostProfile.management = [profile];
  const profileBytes = JSON.stringify(hostProfile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
  descriptor.owners[0].profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256 =
    digest(profileBytes);
  descriptor.management = [
    {
      runtimeId: "claude",
      owner: descriptor.defaultOwner,
      contextId: "local",
      projectPath: null,
      profileId: profile.profileId,
      configRevision: profile.configRevision,
    },
  ];
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  Object.assign(fixture.pins, {
    profileSha256: digest(profileBytes),
    descriptorSha256: digest(descriptorBytes),
  });
  Object.assign(
    fixture.appEnvironment,
    desktopBackendEnvironment(
      fixture.root,
      fixture.node,
      fixture.descriptorPath,
      digest(descriptorBytes),
    ),
  );
  const selection: NativeExtensionProofSelection = {
    profile,
    setup,
    plugin: extensionPlugin,
    nativeConfig: captureNativeClaudeFile(profile, () => {}).path,
    neighborPath,
    neighborSha256: await fileDigest(neighborPath),
  };
  await writeFile(
    join(fixture.root, "native-extensions-selection.json"),
    JSON.stringify(selection),
    { mode: 0o600, flag: "wx" },
  );
  return fixture;
}
