import { readCapturedProfile } from '../owned-process/readCapturedProfile.js';
import { teamHostProfileSchema } from './teamHostProfile.js';

import type { TeamHostProfile } from './teamHostProfile.js';

/** Captured private file and digest are supplied by the trusted Desktop profile. */
export function readTeamHostProfile(path: string, sha256: string): TeamHostProfile {
  return teamHostProfileSchema.parse(readCapturedProfile(path, sha256));
}
