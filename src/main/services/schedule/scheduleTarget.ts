/** Where a schedule really runs. Ordinary teams keep their own name. */
export type ScheduleTarget =
  | { kind: 'native' }
  | { kind: 'project'; executionTeamName: string; projectPath: string }
  | { kind: 'refused'; reason: string };

export type ScheduleAdmission = { allowed: true } | { allowed: false; reason: string };

/** A launch the team's own admission turned down; recorded as a skip, never as a failure. */
export interface ScheduleLaunchRefusal {
  refused: string;
}

/** The reason a team may not be scheduled, or null. A plain `false` keeps a generic reason. */
export function admissionRefusal(admission: boolean | ScheduleAdmission): string | null {
  if (admission === true || (admission !== false && admission.allowed)) return null;
  return admission === false ? 'Scheduling is unavailable for this team' : admission.reason;
}
