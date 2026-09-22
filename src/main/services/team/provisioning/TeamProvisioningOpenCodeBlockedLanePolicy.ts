import {
  appendDiagnosticOnce,
  createUnexpectedMixedSecondaryLaneFailureResult,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeLaunchResult } from '../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';

/**
 * One OpenCode host serves every lane of a project, so a lane whose project
 * runtime already failed is finished without ever being handed to the runtime.
 * Producer and consumer of that state live together here: the lane carries a
 * marker for it, and teardown reads the marker rather than the wording of the
 * diagnostic the user sees.
 */
export function markOpenCodeLaneBlockedBySharedRuntimeFailure(input: {
  teamName: string;
  lane: {
    laneId: string;
    member: { name: string };
    runId: string | null;
    state: 'queued' | 'launching' | 'finished';
    result: TeamRuntimeLaunchResult | null;
    warnings: string[];
    diagnostics: string[];
    queuedAtMs?: number;
    launchFinishedAtMs?: number;
    blockedBeforeLaunch?: true;
  };
  rootCause: string;
  nowMs: number;
  createRunId(): string;
}): void {
  const { lane } = input;
  lane.queuedAtMs = lane.queuedAtMs ?? input.nowMs;
  lane.launchFinishedAtMs = input.nowMs;
  lane.runId = lane.runId ?? input.createRunId();
  lane.state = 'finished';
  lane.blockedBeforeLaunch = true;
  const message =
    `OpenCode runtime preflight failed before ${lane.member.name} could start. ` +
    `This lane was not attempted because it uses the same project runtime. Root cause: ${input.rootCause}`;
  const skippedResult = createUnexpectedMixedSecondaryLaneFailureResult({
    runId: lane.runId,
    teamName: input.teamName,
    memberName: lane.member.name,
    message,
  });
  lane.result = {
    ...skippedResult,
    diagnostics: [input.rootCause, message],
    members: {
      ...skippedResult.members,
      [lane.member.name]: {
        ...skippedResult.members[lane.member.name],
        diagnostics: [input.rootCause, message],
      },
    },
  };
  lane.warnings = [];
  lane.diagnostics = appendDiagnosticOnce([...lane.diagnostics, input.rootCause], message);
}

/**
 * Whether the lane was finished before any launch, which decides that teardown
 * must not register a stop owner for it or ask the adapter to stop it.
 */
export function wasOpenCodeLaneBlockedBeforeLaunch(lane: MixedSecondaryRuntimeLaneState): boolean {
  return lane.blockedBeforeLaunch === true;
}
