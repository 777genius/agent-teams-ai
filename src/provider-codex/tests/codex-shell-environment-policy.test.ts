import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexCliAgentDriver,
  CodexCliSessionDriver,
  CodexEphemeralSessionMaterializer,
  codexShellEnvironmentPolicyConfigToml,
  sessionArtifactFromCodexAuthJson,
} from "../index";
import {
  StaticRunner,
  refreshedAuthJson,
  validAuthJson,
} from "./codex-provider-test-support";

const EXPECTED_POLICY = [
  "[shell_environment_policy]",
  'inherit = "all"',
  'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
].join("\n");

const SECRET_ENV = {
  GITHUB_TOKEN: "must-not-expand",
  AWS_SECRET_ACCESS_KEY: "must-not-expand",
  OPENAI_API_KEY: "must-not-expand",
} as const;

function expectStrictShellEnvironmentPolicy(configToml: string): void {
  const policy = configToml
    .split("[shell_environment_policy]\n")[1]
    ?.split("\n\n")[0];

  expect(policy).toBe(
    [
      'inherit = "all"',
      'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    ].join("\n"),
  );
  expect(configToml.match(/\[shell_environment_policy\]/g)).toHaveLength(1);
  expect(configToml).not.toContain('inherit = "none"');
  for (const [name, value] of Object.entries(SECRET_ENV)) {
    expect(configToml).not.toContain(name);
    expect(configToml).not.toContain(value);
  }
}

function expectSecretsPruned(
  env: Readonly<Record<string, string>> | null,
): void {
  for (const name of Object.keys(SECRET_ENV)) {
    expect(env).not.toHaveProperty(name);
  }
}

describe("Codex shell environment policy", () => {
  it("renders the single strict PATH/toolchain allowlist", () => {
    expect(codexShellEnvironmentPolicyConfigToml()).toBe(EXPECTED_POLICY);
  });

  it("materializes inherit=all with only the strict allowlist", async () => {
    const materializer = new CodexEphemeralSessionMaterializer();
    const materialized = await materializer.materialize({
      session: sessionArtifactFromCodexAuthJson(validAuthJson),
      redactor: new DefaultRedactor(),
    });

    try {
      expectStrictShellEnvironmentPolicy(
        await readFile(join(materialized.codexHome, "config.toml"), "utf8"),
      );
    } finally {
      await materialized.release();
    }
  });

  it("writes the strict policy for legacy task execution without expanding source secrets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-policy-agent-"));
    let configToml = "";
    const runner = new StaticRunner("OK", async ({ env }) => {
      configToml = await readFile(join(env.CODEX_HOME!, "config.toml"), "utf8");
    });
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      sourceEnv: {
        PATH: "/usr/bin",
        ...SECRET_ENV,
      },
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expectStrictShellEnvironmentPolicy(configToml);
      expectSecretsPruned(runner.lastEnv);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("writes the strict policy for legacy session refresh without expanding source secrets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-policy-session-"));
    let configToml = "";
    const runner = new StaticRunner("OK", async ({ env }) => {
      configToml = await readFile(join(env.CODEX_HOME!, "config.toml"), "utf8");
      await writeFile(join(env.CODEX_HOME!, "auth.json"), refreshedAuthJson);
    });
    const driver = new CodexCliSessionDriver({
      codexBinaryPath: "/bin/codex-test",
      sourceEnv: {
        PATH: "/usr/bin",
        ...SECRET_ENV,
      },
    });

    try {
      await driver.refreshSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expectStrictShellEnvironmentPolicy(configToml);
      expectSecretsPruned(runner.lastEnv);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
