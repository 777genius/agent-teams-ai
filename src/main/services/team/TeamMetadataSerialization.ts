/** Canonical metadata readers and writers share the same persisted UTF-8 limit. */
export const MAX_TEAM_METADATA_BYTES = 256 * 1024;

export class TeamMetadataTooLargeError extends Error {
  readonly name = 'TeamMetadataTooLargeError';
  readonly code = 'TEAM_METADATA_TOO_LARGE';
  readonly statusCode = 413;

  constructor() {
    super('Saved team metadata exceeds the supported 256 KiB UTF-8 size');
  }
}

export function serializeTeamMetadata(payload: unknown): string {
  const serialized = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TEAM_METADATA_BYTES) {
    throw new TeamMetadataTooLargeError();
  }
  return serialized;
}
