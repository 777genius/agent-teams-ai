#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const defaultLocalRoot = "~/.cache/subscription-runtime/live-codex-auth";
const defaultRemoteRoot = "/var/data/codex-home/live-codex-auth";
const defaultFiles = ["auth.json", "models_cache.json", "installation_id"];

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const host = requiredString(args.host, "--host");
const accounts = parseList(requiredString(args.accounts, "--accounts"));
const localRoot = expandHome(stringArg(args.localRoot) ?? defaultLocalRoot);
const remoteRoot = stringArg(args.remoteRoot) ?? defaultRemoteRoot;
const files = parseList(stringArg(args.files) ?? defaultFiles.join(","));
const dryRun = Boolean(args.dryRun);

for (const account of accounts) assertSafeName(account, "account");
for (const file of files) assertSafeRelativeFile(file);

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const stagingRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-auth-sync-"));

try {
  for (const account of accounts) {
    const sourceDir = join(localRoot, account);
    await assertReadableFile(join(sourceDir, "auth.json"));
    const stagingAccountDir = join(stagingRoot, account);
    await mkdir(stagingAccountDir, { recursive: true, mode: 0o700 });

    const copiedFiles = [];
    for (const file of files) {
      const sourcePath = join(sourceDir, file);
      if (!(await fileExists(sourcePath))) continue;
      await copyFile(sourcePath, join(stagingAccountDir, basename(file)));
      copiedFiles.push(file);
    }

    if (!copiedFiles.includes("auth.json")) {
      throw new Error(`missing required auth.json for ${account}`);
    }

    const remoteTemp = `.sync-${account}-${stamp}-${process.pid}`;
    const remotePath = `${remoteRoot}/${remoteTemp}`;
    console.log(`${account}: prepared ${copiedFiles.length} auth files`);

    if (dryRun) {
      console.log(`${account}: dry-run, would upload to ${host}:${remotePath}`);
      continue;
    }

    run("ssh", [
      "-o",
      "BatchMode=yes",
      host,
      [
        "set -euo pipefail",
        `root=${shellQuote(remoteRoot)}`,
        `tmp=${shellQuote(remoteTemp)}`,
        "mkdir -p \"$root\"",
        "chmod 700 \"$root\"",
        "rm -rf \"$root/$tmp\"",
      ].join("; "),
    ]);

    run("rsync", [
      "-az",
      "--delete",
      "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
      `${stagingAccountDir}/`,
      `${host}:${shellQuote(`${remotePath}/`)}`,
    ]);

    run("ssh", [
      "-o",
      "BatchMode=yes",
      host,
      remoteSwapCommand({ remoteRoot, account, remoteTemp, stamp }),
    ]);

    console.log(`${account}: synced`);
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      parsed.help = true;
      continue;
    }
    if (item === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (!item.startsWith("--")) {
      throw new Error(`unexpected argument: ${item}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${item}`);
    }
    parsed[toCamel(item.slice(2))] = value;
    index += 1;
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node scripts/ops/sync-codex-auth-to-host.mjs \\
    --host codex-workers-eu-01 \\
    --accounts account-a,account-d \\
    [--local-root ~/.cache/subscription-runtime/live-codex-auth] \\
    [--remote-root /var/data/codex-home/live-codex-auth] \\
    [--files auth.json,models_cache.json,installation_id] \\
    [--dry-run]

Copies only auth-relevant files. It does not print auth payloads or sync Codex
SQLite state, logs, shell snapshots, memories, plugin cache or backup auth files.`);
}

function requiredString(value, name) {
  const text = stringArg(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/")
    ? resolve(process.env.HOME ?? "", path.slice(2))
    : resolve(path);
}

function assertSafeName(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
}

function assertSafeRelativeFile(value) {
  if (
    value.startsWith("/") ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`unsafe file name: ${value}`);
  }
}

async function assertReadableFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`required auth file is empty or not a file: ${path}`);
  }
}

async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function run(command, argv) {
  const result = spawnSync(command, argv, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status === 0) return;
  const stderr = redactProcessOutput(result.stderr);
  const stdout = redactProcessOutput(result.stdout);
  throw new Error([
    `${command} failed with exit ${result.status ?? "unknown"}`,
    stderr ? `stderr: ${stderr}` : "",
    stdout ? `stdout: ${stdout}` : "",
  ].filter(Boolean).join("\n"));
}

function remoteSwapCommand(input) {
  return [
    "set -euo pipefail",
    `root=${shellQuote(input.remoteRoot)}`,
    `account=${shellQuote(input.account)}`,
    `tmp=${shellQuote(input.remoteTemp)}`,
    `backup=${shellQuote(`.previous-${input.account}-${input.stamp}-${process.pid}`)}`,
    "test -s \"$root/$tmp/auth.json\"",
    "chmod -R go-rwx \"$root/$tmp\"",
    "if [ -e \"$root/$account\" ]; then mv \"$root/$account\" \"$root/$backup\"; fi",
    "if mv \"$root/$tmp\" \"$root/$account\"; then rm -rf \"$root/$backup\"; else if [ -e \"$root/$backup\" ]; then mv \"$root/$backup\" \"$root/$account\"; fi; exit 1; fi",
  ].join("; ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function redactProcessOutput(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "jwt-[redacted]")
    .trim();
}
