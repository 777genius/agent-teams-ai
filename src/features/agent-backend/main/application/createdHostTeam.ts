import { setTimeout as delay } from 'node:timers/promises';

import { createdTeamSelectionSignature } from '@shared/utils/createdTeamReadiness';

import { hostTeamSelectionKey } from '../../contracts';
import { hostTeamRunId } from '../../contracts/teamRunSelection';

import { assertBackendRequestGuard, BackendRoutingError } from './backendBinding';
import { captureConfiguredHostTeamDraft } from './createConfiguredHostTeam';

import type { BackendRequestGuard } from './backendBinding';
import type {
  CreateTeamLaunchPreparationInput,
  CreateTeamLaunchPreparationSnapshot,
  CreateTeamLaunchSubmitResult,
} from '@agent-teams/legacy-agent-host/team-registry/create-launch-contracts';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningPrepareResult,
} from '@shared/types/team';

export interface CapturedTeamCreationPort {
  prepare(
    action: 'prepare' | 'probe.read' | 'probe.cancel',
    input: CreateTeamLaunchPreparationInput
  ): Promise<CreateTeamLaunchPreparationSnapshot>;
  submit(
    commandId: string,
    input: CreateTeamLaunchPreparationInput
  ): Promise<CreateTeamLaunchSubmitResult>;
}

function preparation(
  contextId: string,
  preparationId: unknown,
  draft: unknown
): CreateTeamLaunchPreparationInput {
  if (
    typeof preparationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(preparationId)
  )
    throw new BackendRoutingError('invalid-binding');
  return { preparationId, draft: captureConfiguredHostTeamDraft(contextId, draft) };
}

/** A bounded foreground check; existing Host probe records own spend, results and cleanup. */
export async function prepareCreatedHostTeam(options: {
  target: CapturedTeamCreationPort;
  contextId: string;
  preparationId: unknown;
  draft: unknown;
  guard: BackendRequestGuard;
  wait?: () => Promise<unknown>;
}): Promise<TeamProvisioningPrepareResult> {
  const input = preparation(options.contextId, options.preparationId, options.draft);
  const signature = createdTeamSelectionSignature(options.draft as TeamCreateRequest);
  const current = () => assertBackendRequestGuard(options.guard);
  const deadline = performance.now() + 90_000;
  let active = false;
  try {
    current();
    active = true;
    let snapshot = await options.target.prepare('prepare', input);
    while (true) {
      current();
      if (snapshot.preparationId !== input.preparationId)
        throw new BackendRoutingError('hold', 'unknown');
      if (snapshot.ready) {
        const expiresAt = Math.min(...snapshot.probes.map((probe) => probe.expiresAt));
        if (
          !snapshot.probes.length ||
          !snapshot.probes.every((probe) => probe.ok && probe.phase === 'completed') ||
          expiresAt <= Date.now()
        )
          throw new BackendRoutingError('hold', 'unknown');
        return {
          ready: true,
          message: 'All selected providers are ready.',
          createdTeamReadiness: {
            preparationId: input.preparationId,
            selectionSignature: signature,
            draftDigest: snapshot.draftDigest,
            expiresAt,
          },
        };
      }
      if (
        snapshot.probes.some(
          (probe) =>
            probe.phase === 'held' ||
            probe.phase === 'cancelled' ||
            (probe.phase === 'completed' && (!probe.ok || probe.expiresAt <= Date.now()))
        )
      )
        return {
          ready: false,
          message:
            'Captured Host model verification did not complete successfully. Refresh the unchanged form.',
        };
      if (performance.now() >= deadline)
        return {
          ready: false,
          message: 'Captured Host model verification timed out. Refresh status before retrying.',
        };
      await (options.wait?.() ?? delay(200));
      current();
      snapshot = await options.target.prepare('probe.read', input);
      current();
      if (
        !snapshot.ready &&
        !snapshot.probes.some((probe) => probe.phase === 'running') &&
        snapshot.probes.some((probe) => probe.phase === 'not-started')
      )
        snapshot = await options.target.prepare('prepare', input);
    }
  } finally {
    // Cancels only original private probe IDs; never reads a new foreground owner.
    if (active) await options.target.prepare('probe.cancel', input).catch(() => undefined);
  }
}

/** Create and launch stay on one captured owner and one original command. */
export async function createLaunchedHostTeam(options: {
  target: CapturedTeamCreationPort;
  contextId: string;
  request: unknown;
  guard: BackendRequestGuard;
}): Promise<TeamCreateResponse> {
  if (!options.request || typeof options.request !== 'object' || Array.isArray(options.request))
    throw new BackendRoutingError('invalid-binding');
  const {
    command,
    createdTeamReadiness: proof,
    ...draft
  } = structuredClone(options.request) as Record<string, unknown>;
  if (
    !command ||
    typeof command !== 'object' ||
    Array.isArray(command) ||
    !proof ||
    typeof proof !== 'object' ||
    Array.isArray(proof)
  )
    throw new BackendRoutingError('invalid-binding');
  const identity = command as Record<string, unknown>,
    readiness = proof as Record<string, unknown>;
  if (
    Object.keys(identity).some((key) => !['commandId', 'idempotencyKey'].includes(key)) ||
    typeof identity.commandId !== 'string' ||
    !identity.commandId.trim() ||
    identity.commandId.length > 240 ||
    /[\0\r\n]/u.test(identity.commandId) ||
    identity.idempotencyKey !== identity.commandId ||
    Object.keys(readiness).some(
      (key) => !['preparationId', 'selectionSignature', 'draftDigest', 'expiresAt'].includes(key)
    ) ||
    typeof readiness.draftDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(readiness.draftDigest) ||
    typeof readiness.expiresAt !== 'number' ||
    !Number.isFinite(readiness.expiresAt) ||
    readiness.selectionSignature !==
      createdTeamSelectionSignature(draft as unknown as TeamCreateRequest)
  )
    throw new BackendRoutingError('invalid-binding');
  const input = preparation(options.contextId, readiness.preparationId, draft);
  assertBackendRequestGuard(options.guard);
  // Host validates original probe records. An already-admitted original start can
  // be recovered after proof expiry; the renderer timestamp is never authority.
  const result = await options.target.submit(identity.commandId, input);
  assertBackendRequestGuard(options.guard, 'unknown');
  const handleId = result.creation.record.binding.handleId;
  return {
    teamName: hostTeamSelectionKey(handleId),
    runId: hostTeamRunId(handleId, result.launch.launchId, result.launch.rosterRevision),
    launchStatus: 'started',
  };
}
