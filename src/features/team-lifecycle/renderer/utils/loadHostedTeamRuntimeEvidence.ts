import { HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION } from '../../contracts/hosted-lifecycle-commands';

import type { CanonicalTeamLifecycleListItem } from '../../contracts';
import type {
  HostedLifecycleControlStateRequest,
  HostedLifecycleControlStateResult,
} from '../../contracts/hosted-lifecycle-commands';
import type { Revision, TeamId } from '@shared/contracts/hosted';

export const HOSTED_DIRECTORY_CONTROL_CONCURRENCY = 4;
export const HOSTED_DIRECTORY_CONTROL_DEADLINE_MS = 10_000;

export type HostedRuntimeEvidence = Readonly<{
  runtime: 'running' | 'offline' | 'unknown';
  teamRevision: Revision;
  controlRevision: Revision | null;
}>;

export interface HostedRuntimeEvidenceWave {
  readonly byTeamId: ReadonlyMap<TeamId, HostedRuntimeEvidence>;
  /** False when any control read failed, timed out, or returned an unproved action shape. */
  readonly complete: boolean;
}

export type HostedControlStateRead = (
  request: HostedLifecycleControlStateRequest,
  signal?: AbortSignal
) => Promise<HostedLifecycleControlStateResult>;

function classifyControlState(
  item: CanonicalTeamLifecycleListItem,
  result: HostedLifecycleControlStateResult | null
): HostedRuntimeEvidence {
  if (
    result?.kind !== 'control_state' ||
    result.workspaceId !== item.workspaceId ||
    result.teamId !== item.teamId
  ) {
    return { runtime: 'unknown', teamRevision: item.revision, controlRevision: null };
  }

  const action = result.availableActions.length === 1 ? result.availableActions[0] : null;
  const runtime =
    action === 'stop' && result.runId !== null
      ? 'running'
      : action === 'launch' && result.runId === null
        ? 'offline'
        : 'unknown';
  return {
    runtime,
    teamRevision: item.revision,
    controlRevision: result.resourceRevision,
  };
}

/** One bounded, cancellable wave over a complete revision-pinned directory snapshot. */
export async function loadHostedTeamRuntimeEvidence(
  items: readonly CanonicalTeamLifecycleListItem[],
  read: HostedControlStateRead,
  signal: AbortSignal,
  deadlineMs = HOSTED_DIRECTORY_CONTROL_DEADLINE_MS
): Promise<HostedRuntimeEvidenceWave> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, Math.max(0, deadlineMs));
  const byTeamId = new Map<TeamId, HostedRuntimeEvidence>();
  let nextIndex = 0;
  let complete = true;

  const readOne = async (item: CanonicalTeamLifecycleListItem): Promise<void> => {
    const request: HostedLifecycleControlStateRequest = {
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      workspaceId: item.workspaceId,
      teamId: item.teamId,
    };
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      if (controller.signal.aborted) resolve(null);
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let result: HostedLifecycleControlStateResult | null;
    try {
      result = await Promise.race([
        Promise.resolve()
          .then(() => read(request, controller.signal))
          .catch(() => null),
        aborted,
      ]);
    } finally {
      if (onAbort !== null) controller.signal.removeEventListener('abort', onAbort);
    }
    const evidence = classifyControlState(item, result);
    byTeamId.set(item.teamId, evidence);
    if (evidence.runtime === 'unknown') complete = false;
  };

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted && nextIndex < items.length) {
      const item = items[nextIndex++];
      await readOne(item);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(HOSTED_DIRECTORY_CONTROL_CONCURRENCY, items.length) }, () =>
        worker()
      )
    );
    return Object.freeze({
      byTeamId,
      complete: complete && !controller.signal.aborted && byTeamId.size === items.length,
    });
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
