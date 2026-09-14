import type { TeamIdentityStorageErrorCode as TeamIdentityStorageErrorCodeValue } from '../../../contracts/teamIdentityStorageContracts';

export class TeamIdentityStorageInvariantError extends Error {
  readonly name = 'TeamIdentityStorageInvariantError';

  constructor(readonly code: TeamIdentityStorageErrorCodeValue) {
    super(`team-identity-storage:${code}`);
  }
}

export function fail(code: TeamIdentityStorageErrorCodeValue): never {
  throw new TeamIdentityStorageInvariantError(code);
}
