import type { TeamProcess } from '@shared/types';

export function isTeamProcessAlive(proc: TeamProcess, isTeamAlive?: boolean): boolean {
  return proc.processRef
    ? proc.observation === 'same-live'
    : isTeamAlive === true && !proc.stoppedAt;
}
