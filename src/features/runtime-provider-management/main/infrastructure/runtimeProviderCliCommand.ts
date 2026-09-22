import path from 'node:path';

import { getHomeDir } from '@main/utils/pathDecoder';

export const RUNTIME_PROVIDER_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const SPAWN_OUTPUT_TRUNCATED_MARKER = '...[truncated runtime provider command output]';

export function normalizeProjectPath(projectPath: string | null | undefined): string | null {
  const normalized = projectPath?.trim();
  return normalized ? normalized : null;
}

export function appendProjectPathArgs(args: string[], projectPath: string | null): string[] {
  return projectPath ? [...args, '--project-path', projectPath] : args;
}

export function appendOptionalArg(
  args: string[],
  name: string,
  value: string | null | undefined
): void {
  const normalized = value?.trim();
  if (normalized) args.push(name, normalized);
}

export function runtimeProviderCommandOptions<T extends { env: NodeJS.ProcessEnv }>(
  options: T,
  projectPath: string | null
): T & { cwd?: string; maxBuffer: number } {
  const isUsableCwd = (candidate: string | null | undefined): candidate is string => {
    const normalized = candidate?.trim();
    if (!normalized) return false;
    const resolved = path.resolve(normalized);
    return resolved !== path.parse(resolved).root;
  };
  const fallbackHome = [options.env.HOME, options.env.USERPROFILE, getHomeDir()]
    .map((candidate) => candidate?.trim())
    .find(isUsableCwd);
  const commandOptions = {
    ...options,
    maxBuffer: RUNTIME_PROVIDER_COMMAND_MAX_BUFFER_BYTES,
  };
  const cwd = isUsableCwd(projectPath) ? projectPath.trim() : fallbackHome;
  return cwd ? { ...commandOptions, cwd } : commandOptions;
}

export interface BoundedSpawnOutputBuffer {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

export function createBoundedSpawnOutputBuffer(): BoundedSpawnOutputBuffer {
  return { chunks: [], bytes: 0, truncated: false };
}

export function appendBoundedSpawnOutput(buffer: BoundedSpawnOutputBuffer, chunk: Buffer): void {
  if (buffer.bytes >= RUNTIME_PROVIDER_COMMAND_MAX_BUFFER_BYTES) {
    buffer.truncated = true;
    return;
  }
  const remaining = RUNTIME_PROVIDER_COMMAND_MAX_BUFFER_BYTES - buffer.bytes;
  if (chunk.length > remaining) {
    buffer.chunks.push(chunk.subarray(0, remaining));
    buffer.bytes += remaining;
    buffer.truncated = true;
    return;
  }
  buffer.chunks.push(chunk);
  buffer.bytes += chunk.length;
}

export function readBoundedSpawnOutput(
  buffer: BoundedSpawnOutputBuffer,
  options?: { includeTruncationMarker?: boolean }
): string {
  const output = Buffer.concat(buffer.chunks, buffer.bytes).toString('utf8');
  return options?.includeTruncationMarker && buffer.truncated
    ? `${SPAWN_OUTPUT_TRUNCATED_MARKER}\n${output}`
    : output;
}
