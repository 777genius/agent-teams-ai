import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { HttpBadRequestError } from '../teamRouteParsers';

import type { HttpServices } from '../index';
import type { FastifyInstance } from 'fastify';

type MemberWorkSyncRuntimeStopFeature = Pick<
  NonNullable<HttpServices['memberWorkSyncFeature']>,
  'getStatus' | 'stopAutoResume'
>;

type RuntimeStopResponse = {
  ok: true;
  status: Awaited<ReturnType<MemberWorkSyncRuntimeStopFeature['getStatus']>>;
  runtimeAdmission: { state: string };
};

type RuntimeStopReplayEntry = {
  promise: Promise<RuntimeStopResponse>;
};

function getRuntimeStopStatusCode(
  error: unknown,
  getStatusCode: (error: unknown) => number
): number {
  return error instanceof Error &&
    (error.name === 'MemberWorkSyncStaleIncarnationError' ||
      error.name === 'MemberWorkSyncStaleRuntimeInstanceError' ||
      error.name === 'MemberWorkSyncRuntimeControlUnavailableError')
    ? 409
    : getStatusCode(error);
}

export interface MemberWorkSyncRuntimeStopRouteDependencies {
  getFeature: () => MemberWorkSyncRuntimeStopFeature;
  getTeamsBasePath: () => string;
  readCurrentNativeRuntimeInstanceId: (input: {
    teamsBasePath: string;
    teamName: string;
    memberName: string;
  }) => Promise<string | null>;
  logger: { error(message: string, detail: string): void };
  shouldLogError: (error: unknown) => boolean;
  getStatusCode: (error: unknown) => number;
  getResponseErrorMessage: (error: unknown, statusCode?: number) => string;
}

function assertValidMemberName(memberName: string): string {
  const validatedMemberName = validateMemberName(memberName);
  if (!validatedMemberName.valid) {
    throw new HttpBadRequestError(validatedMemberName.error ?? 'Invalid memberName');
  }
  return validatedMemberName.value!;
}

export function registerMemberWorkSyncRuntimeStopRoute(
  app: FastifyInstance,
  dependencies: MemberWorkSyncRuntimeStopRouteDependencies
): void {
  const runtimeStopReplay = new Map<string, RuntimeStopReplayEntry>();

  const runRuntimeStopOnce = (
    replayKey: string,
    mutation: () => Promise<RuntimeStopResponse>
  ): Promise<RuntimeStopResponse> => {
    const replay = runtimeStopReplay.get(replayKey);
    if (replay) return replay.promise;

    const entry: RuntimeStopReplayEntry = {
      promise: Promise.resolve().then(mutation),
    };
    entry.promise = entry.promise.then(
      (response) => {
        if (runtimeStopReplay.get(replayKey) === entry) runtimeStopReplay.delete(replayKey);
        return response;
      },
      (error: unknown) => {
        if (runtimeStopReplay.get(replayKey) === entry) runtimeStopReplay.delete(replayKey);
        throw error;
      }
    );
    runtimeStopReplay.set(replayKey, entry);
    return entry.promise;
  };

  app.post<{
    Params: { teamName: string; memberName: string };
    Body: {
      incarnation?: unknown;
      runtimeInstanceId?: unknown;
      localStopId?: unknown;
      reason?: unknown;
    };
  }>('/api/teams/:teamName/member-work-sync/:memberName/runtime-stop', async (request, reply) => {
    try {
      const validatedTeamName = validateTeamName(request.params.teamName);
      if (!validatedTeamName.valid) {
        return reply.status(400).send({ error: validatedTeamName.error });
      }
      const memberName = request.params.memberName?.trim();
      if (!memberName) {
        return reply.status(400).send({ error: 'memberName is required' });
      }
      const localStopId =
        typeof request.body?.localStopId === 'string' ? request.body.localStopId.trim() : '';
      if (!localStopId) {
        return reply.status(400).send({ error: 'localStopId is required' });
      }
      if (localStopId.length > 256) {
        return reply.status(400).send({ error: 'localStopId is too long' });
      }
      const runtimeInstanceId =
        typeof request.body?.runtimeInstanceId === 'string'
          ? request.body.runtimeInstanceId.trim()
          : '';
      if (!runtimeInstanceId) {
        return reply.status(400).send({ error: 'runtimeInstanceId is required' });
      }
      if (runtimeInstanceId.length > 256) {
        return reply.status(400).send({ error: 'runtimeInstanceId is too long' });
      }
      const incarnation =
        typeof request.body?.incarnation === 'string' ? request.body.incarnation.trim() : '';
      if (!incarnation) {
        return reply.status(400).send({ error: 'incarnation is required' });
      }
      if (incarnation.length > 256) {
        return reply.status(400).send({ error: 'incarnation is too long' });
      }
      const reason =
        typeof request.body?.reason === 'string' && request.body.reason.trim()
          ? request.body.reason.trim()
          : 'runtime_local_stop';
      const teamName = validatedTeamName.value!;
      const validatedMemberName = assertValidMemberName(memberName);

      let currentRuntimeInstanceId: string | null = null;
      try {
        currentRuntimeInstanceId =
          await dependencies.readCurrentNativeRuntimeInstanceId({
            teamsBasePath: dependencies.getTeamsBasePath(),
            teamName,
            memberName: validatedMemberName,
          });
      } catch {
        return reply.status(409).send({ error: 'runtime_identity_unavailable' });
      }
      if (!currentRuntimeInstanceId) {
        return reply.status(409).send({ error: 'runtime_identity_unavailable' });
      }
      if (currentRuntimeInstanceId !== runtimeInstanceId) {
        return reply.status(409).send({ error: 'stale_runtime_instance' });
      }

      const currentStatus = await dependencies.getFeature().getStatus({
        teamName,
        memberName: validatedMemberName,
      });
      const currentIncarnation = currentStatus.statusRevision?.incarnation?.trim();
      if (!currentIncarnation) {
        return reply.status(409).send({ error: 'runtime_incarnation_unavailable' });
      }
      if (currentIncarnation !== incarnation) {
        return reply.status(409).send({ error: 'stale_runtime_incarnation' });
      }

      const replayKey = JSON.stringify([
        teamName,
        validatedMemberName,
        incarnation,
        runtimeInstanceId,
        localStopId,
      ]);
      return reply.send(
        await runRuntimeStopOnce(replayKey, async () => {
          const status = await dependencies.getFeature().stopAutoResume({
            teamName,
            memberName: validatedMemberName,
            reason,
            expectedIncarnation: incarnation,
            expectedRuntimeInstanceId: runtimeInstanceId,
            localStopId,
          });
          return {
            ok: true,
            status,
            runtimeAdmission: status.runtimeAdmission ?? { state: 'unknown' },
          };
        })
      );
    } catch (error) {
      const statusCode = getRuntimeStopStatusCode(error, dependencies.getStatusCode);
      if (statusCode >= 500 && dependencies.shouldLogError(error)) {
        dependencies.logger.error(
          `Error in POST /api/teams/${request.params.teamName}/member-work-sync/${request.params.memberName}/runtime-stop:`,
          getErrorMessage(error)
        );
      }
      return reply
        .status(statusCode)
        .send({ error: dependencies.getResponseErrorMessage(error, statusCode) });
    }
  });
}
