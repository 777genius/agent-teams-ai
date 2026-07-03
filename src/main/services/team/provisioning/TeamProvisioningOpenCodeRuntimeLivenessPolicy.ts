import type { PersistedTeamLaunchMemberState } from '@shared/types';

export function shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange(input: {
  previousMember?: PersistedTeamLaunchMemberState;
  runtimeRunId: string;
  runtimeSessionId: string;
  runtimePid?: number;
}): boolean {
  const previous = input.previousMember;
  if (!previous) {
    return true;
  }
  const previousRuntimeRunId =
    typeof previous.runtimeRunId === 'string' ? previous.runtimeRunId.trim() : '';
  const previousRuntimeSessionId =
    typeof previous.runtimeSessionId === 'string' ? previous.runtimeSessionId.trim() : '';
  if (
    previousRuntimeRunId !== input.runtimeRunId ||
    previousRuntimeSessionId !== input.runtimeSessionId
  ) {
    return true;
  }
  if (
    input.runtimePid !== undefined &&
    (previous.runtimePid === undefined || previous.runtimePid !== input.runtimePid)
  ) {
    return true;
  }
  return (
    previous.launchState !== 'confirmed_alive' ||
    previous.runtimeAlive !== true ||
    previous.bootstrapConfirmed !== true ||
    previous.hardFailure === true
  );
}
