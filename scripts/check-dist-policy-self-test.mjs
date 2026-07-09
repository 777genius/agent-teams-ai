#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checkerPath = join(scriptDir, "check-dist-policy.mjs");

const cases = [
  {
    name: "ignored untracked dist passes",
    trackedDist: false,
    expectPass: true,
  },
  {
    name: "tracked dist fails",
    trackedDist: true,
    expectPass: false,
    expectText: "Generated dist files must not be tracked",
  },
];

for (const testCase of cases) {
  const fixtureDir = await mkdtemp(join(tmpdir(), "subscription-runtime-dist-policy-"));
  try {
    git(["init", "--initial-branch", "main"], fixtureDir);
    await writeFile(join(fixtureDir, ".gitignore"), "dist\n");
    await mkdir(join(fixtureDir, "dist"), { recursive: true });
    await writeFile(join(fixtureDir, "dist", "generated.js"), "export {};\n");
    if (testCase.trackedDist) {
      git(["add", "-f", "dist/generated.js"], fixtureDir);
    }

    const result = spawnSync(process.execPath, [checkerPath], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        SUBSCRIPTION_RUNTIME_DIST_POLICY_ROOT_DIR: fixtureDir,
      },
      encoding: "utf8",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const passed = result.status === 0;

    if (passed !== testCase.expectPass) {
      throw new Error(
        `${testCase.name}: expected pass=${testCase.expectPass}, got pass=${passed}\n${output}`,
      );
    }
    if (testCase.expectText && !output.includes(testCase.expectText)) {
      throw new Error(
        `${testCase.name}: expected output to contain ${JSON.stringify(testCase.expectText)}\n${output}`,
      );
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

console.log("dist policy self-tests OK.");

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
}
