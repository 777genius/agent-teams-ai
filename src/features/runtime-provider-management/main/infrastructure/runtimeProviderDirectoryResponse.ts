import type { RuntimeProviderManagementDirectoryResponse } from '../../contracts';

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
