import type { TeamLaunchResponse } from '@shared/types';

type LaunchOutcome = Pick<TeamLaunchResponse, 'launchStatus' | 'alreadyLaunching' | 'alreadyRunning'>;

/** The launch found the team already running: nothing of the request was applied. */
export function isLaunchAlreadyRunning(response: LaunchOutcome): boolean {
  return response.launchStatus === 'already_running' || response.alreadyRunning === true;
}

/** The launch found another launch of the team underway: nothing of the request was applied. */
export function isLaunchAlreadyUnderway(response: LaunchOutcome): boolean {
  return response.launchStatus === 'already_launching' || response.alreadyLaunching === true;
}

/** The launch started the team with the request it was given. */
export function isFreshLaunch(response: LaunchOutcome): boolean {
  return !isLaunchAlreadyRunning(response) && !isLaunchAlreadyUnderway(response);
}
