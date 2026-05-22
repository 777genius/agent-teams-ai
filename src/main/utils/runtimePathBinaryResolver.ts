import { existsSync, statSync } from 'fs';
import path from 'path';

import { buildMergedCliPath } from './cliPathMerge';
import { getCachedShellEnv } from './shellEnv';

export const RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS = 1_500;

export function isAbsoluteExistingFile(filePath: string | null | undefined): filePath is string {
  if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) {
    return false;
  }
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function splitPathEnv(pathValue: string | undefined): string[] {
  if (!pathValue) {
    return [];
  }
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectExecutableCandidatesFromPathEntries(
  pathEntries: string[],
  executableNames: string[],
  seenPathEntries: Set<string>
): string[] {
  const results: string[] = [];
  for (const entry of pathEntries) {
    const normalizedEntry = path.resolve(entry);
    if (seenPathEntries.has(normalizedEntry)) {
      continue;
    }
    seenPathEntries.add(normalizedEntry);
    for (const executableName of executableNames) {
      const candidate = path.join(normalizedEntry, executableName);
      if (isAbsoluteExistingFile(candidate)) {
        results.push(candidate);
      }
    }
  }
  return results;
}

export interface RuntimePathBinaryCandidateOptions {
  executableNames: string[];
  additionalEnvSources?: (NodeJS.ProcessEnv | null | undefined)[];
  includeFallbackPathEntries?: boolean;
  extraCandidates?: string[];
}

export function collectRuntimePathBinaryCandidates(
  options: RuntimePathBinaryCandidateOptions
): string[] {
  const additionalEnvSources = options.additionalEnvSources ?? [];
  const shellEnv = getCachedShellEnv() ?? {};
  const directPathEntries = [
    ...additionalEnvSources.flatMap((env) => splitPathEnv(env?.PATH)),
    ...splitPathEnv(shellEnv.PATH),
  ];
  const fallbackPathEntries =
    options.includeFallbackPathEntries === false
      ? []
      : [...splitPathEnv(buildMergedCliPath(null)), ...splitPathEnv(process.env.PATH)];
  const seenPathEntries = new Set<string>();
  return [
    ...collectExecutableCandidatesFromPathEntries(
      directPathEntries,
      options.executableNames,
      seenPathEntries
    ),
    ...(options.extraCandidates ?? []).filter(isAbsoluteExistingFile),
    ...collectExecutableCandidatesFromPathEntries(
      fallbackPathEntries,
      options.executableNames,
      seenPathEntries
    ),
  ];
}

export function findFirstRuntimePathBinaryCandidate(
  options: RuntimePathBinaryCandidateOptions
): string | null {
  return collectRuntimePathBinaryCandidates(options)[0] ?? null;
}
