#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const checks = [
  { label: "working tree", args: ["--check"] },
  { label: "index", args: ["--cached", "--check"] },
];

const baseRef = resolveDiffBase();
if (baseRef !== undefined) {
  checks.push({ label: `${baseRef}..HEAD`, args: ["--check", `${baseRef}..HEAD`] });
}

let failed = false;
for (const check of checks) {
  const result = spawnSync("git", ["diff", ...check.args], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`git diff --check failed for ${check.label}`);
  }
}

if (failed) process.exit(1);

function resolveDiffBase() {
  const explicit = process.env.SUBSCRIPTION_RUNTIME_DIFF_BASE?.trim();
  if (explicit && revExists(explicit)) return mergeBase(explicit) ?? explicit;

  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  if (githubBase) {
    for (const ref of [`origin/${githubBase}`, githubBase]) {
      if (revExists(ref)) return mergeBase(ref) ?? ref;
    }
  }

  for (const ref of ["origin/main", "vioxen/main", "main", "HEAD~1"]) {
    if (revExists(ref)) return mergeBase(ref) ?? ref;
  }
  return undefined;
}

function revExists(ref) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    stdio: "ignore",
  }).status === 0;
}

function mergeBase(ref) {
  const result = spawnSync("git", ["merge-base", ref, "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}
