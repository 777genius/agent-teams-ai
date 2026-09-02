#!/usr/bin/env node

// Builds the Windows OpenCode console wrapper into
// resources/runtime/opencode-console/opencode.exe.
//
// The orchestrator starts `opencode serve` hosts detached (no console), so every
// console-subsystem child those hosts spawn (cmd.exe for the bash tool,
// cursor-agent.cmd -> powershell, ...) allocates a NEW visible console window
// that flashes and steals focus. The wrapper (tools/opencode-console-wrapper) is
// a GUI-subsystem launcher that starts the real binary with CREATE_NO_WINDOW, so
// the host gets a hidden console that all of its descendants inherit.
//
// src/main/services/runtime/openCodeRuntimeBinaryEnv.ts picks the wrapper up only
// when this file exists, so skipping the build (non-Windows host, no C# compiler)
// simply leaves the runtime pointing at the real binary.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const sourcePath = path.join(
  repoRoot,
  'tools',
  'opencode-console-wrapper',
  'OpenCodeConsoleWrapper.cs'
);
const outputDir = path.join(repoRoot, 'resources', 'runtime', 'opencode-console');
const outputPath = path.join(outputDir, 'opencode.exe');

function printUsage() {
  process.stdout.write(`Usage: node scripts/stage-opencode-console-wrapper.mjs [options]

Options:
  --platform <key>  Target platform key (e.g. win32-x64). Defaults to the current
                    platform. Non-Windows targets skip the build.
  --clean           Remove the staged wrapper.
  --require         Fail when the wrapper cannot be built (default: skip with a notice).
  --help            Show this message.
`);
}

function parseArgs(argv) {
  const parsed = { clean: false, help: false, platform: null, require: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--clean') {
      parsed.clean = true;
    } else if (arg === '--require') {
      parsed.require = true;
    } else if (arg === '--platform') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--platform requires a value (e.g. win32-x64)');
      }
      parsed.platform = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/** `win32-arm64` -> `win32`; an empty key falls back to the host platform. */
function resolveTargetPlatform(platformKey) {
  const trimmed = platformKey?.trim();
  if (!trimmed) {
    return process.platform;
  }
  return trimmed.split('-')[0];
}

/** .NET Framework ships csc.exe with Windows itself; Roslyn/dotnet are optional extras. */
function resolveCompiler() {
  const fromEnv = process.env.AGENT_TEAMS_CSC_PATH?.trim();
  if (fromEnv) {
    return fs.existsSync(fromEnv) ? fromEnv : null;
  }

  const windowsDir = process.env.SystemRoot?.trim() || 'C:\\Windows';
  const frameworkRoots = [
    path.join(windowsDir, 'Microsoft.NET', 'Framework64'),
    path.join(windowsDir, 'Microsoft.NET', 'Framework'),
  ];

  const candidates = [];
  for (const root of frameworkRoots) {
    let versions = [];
    try {
      versions = fs.readdirSync(root).filter((entry) => entry.startsWith('v'));
    } catch {
      continue;
    }
    // Newest framework version first (v4.0.30319 before v3.5).
    versions.sort().reverse();
    for (const version of versions) {
      candidates.push(path.join(root, version, 'csc.exe'));
    }
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function skipOrFail(reason, shouldFail) {
  if (shouldFail) {
    process.stderr.write(`stage-opencode-console-wrapper: ${reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`stage-opencode-console-wrapper: skipped (${reason}).\n`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    printUsage();
    process.exit(1);
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  if (args.clean) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    process.stdout.write('stage-opencode-console-wrapper: cleaned.\n');
    return;
  }

  const targetPlatform = resolveTargetPlatform(args.platform);
  if (targetPlatform !== 'win32') {
    skipOrFail(`the console wrapper is Windows-only (target ${targetPlatform})`, args.require);
    return;
  }
  if (process.platform !== 'win32') {
    skipOrFail('the console wrapper can only be compiled on Windows', args.require);
    return;
  }

  if (!fs.existsSync(sourcePath)) {
    skipOrFail(`source not found at ${sourcePath}`, true);
    return;
  }

  const compiler = resolveCompiler();
  if (!compiler) {
    skipOrFail(
      'no C# compiler found (set AGENT_TEAMS_CSC_PATH or install the .NET Framework compiler)',
      args.require
    );
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  // No /platform: the wrapper is pure IL over kernel32 P/Invokes, so one AnyCPU
  // build serves every Windows architecture. The .NET Framework compiler cannot
  // emit arm64 anyway ("must be anycpu, anycpu32bitpreferred, x86, Itanium, x64
  // or arm"), and an AnyCPU image carries the legacy i386 machine stamp, which
  // is why scripts/electron-builder/afterPack.cjs allows this one path.
  const result = spawnSync(
    compiler,
    ['/nologo', '/target:winexe', '/optimize', `/out:${outputPath}`, sourcePath],
    { stdio: 'inherit' }
  );

  if (result.error) {
    skipOrFail(`compiler failed to start: ${result.error.message}`, args.require);
    return;
  }
  if (result.status !== 0) {
    skipOrFail(`compiler exited with ${result.status}`, args.require);
    return;
  }

  process.stdout.write(
    `stage-opencode-console-wrapper: built ${path.relative(repoRoot, outputPath)}.\n`
  );
}

main();
