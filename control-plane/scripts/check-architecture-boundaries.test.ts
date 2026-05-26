import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "check-architecture-boundaries.mjs",
);

describe("check-architecture-boundaries", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "control-plane-architecture-"));
    await writeFeature("alpha", {
      files: {
        "src/index.ts": "export const alpha = true;\n",
        "src/domain/model.ts": "export const model = true;\n",
      },
    });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("passes for explicit feature entrypoints", async () => {
    await expect(runArchitectureCheck()).resolves.toBeDefined();
  });

  it("fails when domain imports NestJS", async () => {
    await writeFile(
      join(root, "packages/features/alpha/src/domain/forbidden.ts"),
      'import { Injectable } from "@nestjs/common";\nexport const forbidden = Injectable;\n',
    );

    await expect(runArchitectureCheck()).rejects.toMatchObject({
      stderr: expect.stringContaining("Nest belongs to interface/platform wiring"),
    });
  });

  it("fails when one feature imports another feature infrastructure", async () => {
    await writeFeature("beta", {
      files: {
        "src/index.ts": "export const beta = true;\n",
        "src/infrastructure/private-adapter.ts": "export const privateAdapter = true;\n",
      },
    });
    await mkdir(join(root, "packages/features/alpha/src/application"), {
      recursive: true,
    });
    await writeFile(
      join(root, "packages/features/alpha/src/application/use-case.ts"),
      'import { privateAdapter } from "@agent-teams-control-plane/features-beta/infrastructure/private-adapter.js";\nexport const useCase = privateAdapter;\n',
    );

    await expect(runArchitectureCheck()).rejects.toMatchObject({
      stderr: expect.stringContaining("feature infrastructure is private"),
    });
  });

  it("fails when feature exports private layers directly", async () => {
    await writeFeature("beta", {
      exports: {
        ".": {
          default: "./src/index.ts",
          types: "./src/index.ts",
        },
        "./infrastructure/private": {
          default: "./src/infrastructure/private-adapter.ts",
          types: "./src/infrastructure/private-adapter.ts",
        },
      },
      files: {
        "src/index.ts": "export const beta = true;\n",
        "src/infrastructure/private-adapter.ts": "export const privateAdapter = true;\n",
      },
    });

    await expect(runArchitectureCheck()).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "must not expose domain, application, or infrastructure",
      ),
    });
  });

  it("fails when phase-locked infrastructure dependencies are declared", async () => {
    await writeFeature("beta", {
      dependencies: {
        "@octokit/rest": "1.0.0",
      },
      files: {
        "src/index.ts": "export const beta = true;\n",
      },
    });

    await expect(runArchitectureCheck()).rejects.toMatchObject({
      stderr: expect.stringContaining("GitHub SDKs start in the GitHub connector phase"),
    });
  });

  it("fails when shared production code imports NestJS", async () => {
    await writeSharedFile(
      "src/framework-leak.ts",
      'import { Injectable } from "@nestjs/common";\nexport const frameworkLeak = Injectable;\n',
    );

    await expect(runArchitectureCheck()).rejects.toMatchObject({
      stderr: expect.stringContaining("shared kernel must not import Nest"),
    });
  });

  it("fails when shared production code imports platform packages", async () => {
    await writeSharedFile(
      "src/platform-leak.ts",
      'import { ControlPlaneConfigService } from "@agent-teams-control-plane/platform-config";\nexport const platformLeak = ControlPlaneConfigService;\n',
    );

    await expect(runArchitectureCheck()).rejects.toMatchObject({
      stderr: expect.stringContaining("shared kernel must not import platform adapters"),
    });
  });

  async function runArchitectureCheck() {
    return execFileAsync("node", [scriptPath], {
      env: {
        ...process.env,
        CONTROL_PLANE_ARCHITECTURE_ROOT: root,
      },
    });
  }

  async function writeFeature(
    name: string,
    options: {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
      files: Record<string, string>;
    },
  ) {
    const featureRoot = join(root, "packages/features", name);
    await mkdir(featureRoot, { recursive: true });
    await writeFile(
      join(featureRoot, "package.json"),
      `${JSON.stringify(
        {
          name: `@agent-teams-control-plane/features-${name}`,
          version: "0.0.0",
          private: true,
          type: "module",
          exports: options.exports ?? {
            ".": {
              default: "./src/index.ts",
              types: "./src/index.ts",
            },
          },
          ...(options.dependencies === undefined
            ? {}
            : { dependencies: options.dependencies }),
        },
        null,
        2,
      )}\n`,
    );

    for (const [path, source] of Object.entries(options.files)) {
      const filePath = join(featureRoot, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    }
  }

  async function writeSharedFile(path: string, source: string) {
    const sharedRoot = join(root, "packages/shared");
    await mkdir(sharedRoot, { recursive: true });
    await writeFile(
      join(sharedRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@agent-teams-control-plane/shared",
          version: "0.0.0",
          private: true,
          type: "module",
          exports: {
            ".": {
              default: "./src/index.ts",
              types: "./src/index.ts",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const filePath = join(sharedRoot, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  }
});
