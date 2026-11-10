import path from 'node:path';

import type {
  RuntimeProviderCliCompanionCommandResult,
  RuntimeProviderCliCompanionRunCommandOptions,
} from './types';

export const COMPANION_PROBE_TIMEOUT_MS = 10_000;

export function isAmbiguousCompanionBinaryName(
  filePath: string,
  ambiguousExecutableNames: readonly string[] = []
): boolean {
  const names = new Set(ambiguousExecutableNames.map((name) => name.toLowerCase()));
  return names.has(path.basename(filePath).toLowerCase());
}

export async function selectRuntimeProviderCompanionBinary(input: {
  candidates: readonly string[];
  versionArgs: readonly string[];
  runCommand: (
    command: string,
    args: readonly string[],
    options: RuntimeProviderCliCompanionRunCommandOptions
  ) => Promise<RuntimeProviderCliCompanionCommandResult>;
  env: NodeJS.ProcessEnv;
  matchesVersionOutput?: (output: string) => boolean;
  ambiguousExecutableNames?: readonly string[];
}): Promise<string | null> {
  const unambiguous = input.candidates.find(
    (candidate) => !isAmbiguousCompanionBinaryName(candidate, input.ambiguousExecutableNames)
  );
  if (unambiguous) {
    return unambiguous;
  }

  const matcher = input.matchesVersionOutput;
  if (!matcher) {
    return input.candidates[0] ?? null;
  }
  for (const candidate of input.candidates) {
    const result = await input
      .runCommand(candidate, input.versionArgs, {
        env: input.env,
        timeoutMs: COMPANION_PROBE_TIMEOUT_MS,
      })
      .catch(() => null);
    if (!result || result.exitCode !== 0) {
      continue;
    }
    if (matcher(`${result.stdout}\n${result.stderr}`)) {
      return candidate;
    }
  }
  return null;
}

export function trimCommandOutput(result: RuntimeProviderCliCompanionCommandResult): string | null {
  const value = (result.stdout || result.stderr).trim();
  return value ? value.split(/\r?\n/)[0]?.trim() || null : null;
}

export function summarizeCommandFailure(
  result: RuntimeProviderCliCompanionCommandResult
): string | null {
  const ignored = /^(?:installation failed\. cleaning up\.\.\.|next steps:)$/i;
  const actionableFailure =
    /\b(?:failed|failure|error|mismatch|unavailable)\b|\bnot (?:available|found)\b|\bno .+ found\b|\b(?:exit|exited)(?: with)? code\b/i;
  const toLines = (value: string): string[] =>
    value
      .split(/\r?\n/)
      .map((line) => line.replace(/^(?:(?:❌|⚠️|✓|🎉)\s*)+/u, '').trim())
      .filter((line) => line && !ignored.test(line));
  const stderrLines = toLines(result.stderr);
  const stdoutLines = toLines(result.stdout);
  return (
    stderrLines[0] ??
    stdoutLines.find((line) => actionableFailure.test(line)) ??
    stdoutLines.at(-1) ??
    trimCommandOutput(result)
  );
}
