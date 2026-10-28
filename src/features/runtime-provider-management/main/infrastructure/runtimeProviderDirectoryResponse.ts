import type {
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementLoadDirectoryInput,
} from '../../contracts';

const DIRECTORY_RESPONSE_CACHE_TTL_MS = 30_000;
const DEFAULT_DIRECTORY_RESPONSE_CACHE_TTL_MS = 2 * 60_000;

export function getRuntimeProviderDirectoryCacheKey(
  input: RuntimeProviderManagementLoadDirectoryInput,
  projectPath: string | null
): string {
  return JSON.stringify([
    input.runtimeId,
    input.summary === true ? 'summary' : 'full',
    projectPath,
    input.query?.trim() || null,
    input.filter ?? null,
    input.limit ?? null,
    input.cursor?.trim() || null,
  ]);
}

/** The default first page backs the dashboard and lives longer than searches or pages. */
export function getRuntimeProviderDirectoryCacheTtlMs(
  input: RuntimeProviderManagementLoadDirectoryInput
): number {
  const isDefaultDirectory =
    !input.query?.trim() &&
    (input.filter === undefined || input.filter === null || input.filter === 'all') &&
    !input.cursor?.trim();
  return isDefaultDirectory
    ? DEFAULT_DIRECTORY_RESPONSE_CACHE_TTL_MS
    : DIRECTORY_RESPONSE_CACHE_TTL_MS;
}

/** A timed-out passive inventory is unknown, not evidence that every provider disconnected. */
export function normalizeRuntimeProviderDirectoryResponse(
  response: RuntimeProviderManagementDirectoryResponse,
  summary: boolean,
  previous?: RuntimeProviderManagementDirectoryResponse
): RuntimeProviderManagementDirectoryResponse {
  if (!summary || response.runtimeId !== 'opencode') return response;
  const directory = response.directory;
  const timeout = directory?.diagnostics.find((message) =>
    /^OpenCode inventory probe timed out after \d+ms(?: during |$)/u.test(message)
  );
  if (
    !response.error &&
    timeout &&
    directory &&
    directory.entries.every(
      (entry) =>
        entry.state !== 'connected' &&
        !entry.metadata?.configuredAuthless &&
        entry.sources.length > 0 &&
        entry.sources.every((source) => source === 'seed')
    )
  ) {
    response = {
      schemaVersion: response.schemaVersion,
      runtimeId: response.runtimeId,
      error: {
        code: 'runtime-unhealthy',
        message: `OpenCode provider directory could not be loaded. ${timeout.slice(0, 500)}`,
        recoverable: true,
      },
    };
  }
  return response.error && previous?.directory
    ? { ...response, directory: previous.directory }
    : response;
}
