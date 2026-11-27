import { validateTeamName } from '../guards';

import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { IpcResult } from '@shared/types';

/** Preserve the original team-level admission lock for context resolution. */
export async function withTeamLaunchAdmission<T>(
  request: unknown,
  data: Pick<TeamDataService, 'runConfigurationOperation'>,
  run: () => Promise<IpcResult<T>>
): Promise<IpcResult<T>> {
  const name = request && typeof request === 'object'
    ? (request as { teamName?: unknown }).teamName
    : undefined;
  const validated = validateTeamName(name);
  if (!validated.valid) {
    return { success: false, error: validated.error ?? 'Invalid teamName' };
  }
  return data.runConfigurationOperation(validated.value!, run);
}
