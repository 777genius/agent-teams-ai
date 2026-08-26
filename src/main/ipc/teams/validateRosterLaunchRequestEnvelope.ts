import * as fs from 'fs';
import * as path from 'path';

import { isRosterTransactionId } from './rosterAuthorizedLaunch';

import type { TeamLaunchRequest } from '@shared/types';

export type RosterLaunchRequestEnvelopeValidation =
  | { valid: false; error: string }
  | { valid: true; cwd: string; rosterTransactionId: string | undefined };

export async function validateRosterLaunchRequestEnvelope(
  payload: Partial<TeamLaunchRequest>
): Promise<RosterLaunchRequestEnvelopeValidation> {
  if (
    payload.rosterTransactionId !== undefined &&
    !isRosterTransactionId(payload.rosterTransactionId)
  ) {
    return { valid: false, error: 'Invalid rosterTransactionId' };
  }
  if (typeof payload.cwd !== 'string' || payload.cwd.trim().length === 0) {
    return { valid: false, error: 'cwd is required' };
  }
  const cwd = payload.cwd.trim();
  if (!path.isAbsolute(cwd)) return { valid: false, error: 'cwd must be an absolute path' };
  try {
    if (!(await fs.promises.stat(cwd)).isDirectory()) {
      return { valid: false, error: 'cwd must be a directory' };
    }
  } catch {
    return { valid: false, error: 'cwd does not exist' };
  }
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    return { valid: false, error: 'prompt must be a string' };
  }
  if (payload.model !== undefined && typeof payload.model !== 'string') {
    return { valid: false, error: 'model must be a string' };
  }
  if (payload.limitContext !== undefined && typeof payload.limitContext !== 'boolean') {
    return { valid: false, error: 'limitContext must be a boolean' };
  }
  return { valid: true, cwd, rosterTransactionId: payload.rosterTransactionId };
}
