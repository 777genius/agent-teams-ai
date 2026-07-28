import type { MemberWorkSyncReportState } from '../../../contracts';
import type { MemberWorkSyncFeatureFacade } from '../../composition/createMemberWorkSyncFeature';
import type { FastifyInstance, FastifyReply } from 'fastify';

const MEMBER_WORK_SYNC_DIAGNOSTICS_ROUTE = '/api/teams/:teamName/member-work-sync/diagnostics';
const MEMBER_WORK_SYNC_METRICS_ROUTE = '/api/teams/:teamName/member-work-sync/metrics';
const MEMBER_WORK_SYNC_STATUS_ROUTE = '/api/teams/:teamName/member-work-sync/:memberName';
const MEMBER_WORK_SYNC_REFRESH_ROUTE = '/api/teams/:teamName/member-work-sync/:memberName/refresh';
const MEMBER_WORK_SYNC_REPORT_ROUTE = '/api/teams/:teamName/member-work-sync/report';

export interface MemberWorkSyncHttpIdentifierValidationResult {
  valid: boolean;
  value?: string;
  error?: string;
}

export interface MemberWorkSyncHttpIdentifierValidationPort {
  validateTeamName(value: unknown): MemberWorkSyncHttpIdentifierValidationResult;
  validateMemberName(value: unknown): MemberWorkSyncHttpIdentifierValidationResult;
}

export interface MemberWorkSyncHttpClockPort {
  now(): Date;
}

export interface MemberWorkSyncHttpLoggerPort {
  error(message: string, detail: string): void;
}

export interface MemberWorkSyncHttpUnexpectedErrorMapping {
  statusCode: number;
  responseMessage: string;
  shouldLog: boolean;
  logMessage: string;
}

export interface MemberWorkSyncHttpUnexpectedErrorPort {
  map(error: unknown): MemberWorkSyncHttpUnexpectedErrorMapping;
}

export interface MemberWorkSyncHttpHostPorts {
  identifiers: MemberWorkSyncHttpIdentifierValidationPort;
  clock: MemberWorkSyncHttpClockPort;
  logger: MemberWorkSyncHttpLoggerPort;
  unexpectedErrors: MemberWorkSyncHttpUnexpectedErrorPort;
}

interface ValidationFailure {
  valid: false;
  error: string | undefined;
}

interface ValidationSuccess {
  valid: true;
  value: string;
}

type ValidatedIdentifier = ValidationFailure | ValidationSuccess;

interface ReportPayloadFailure {
  valid: false;
  error: string;
}

interface ReportPayloadSuccess {
  valid: true;
  value: Record<string, unknown>;
}

type ReportPayload = ReportPayloadFailure | ReportPayloadSuccess;

export function registerMemberWorkSyncHttp(
  app: FastifyInstance,
  feature: MemberWorkSyncFeatureFacade | undefined,
  host: MemberWorkSyncHttpHostPorts
): void {
  app.get<{ Params: { teamName: string } }>(
    MEMBER_WORK_SYNC_DIAGNOSTICS_ROUTE,
    async (request, reply) => {
      try {
        const teamName = validateTeamName(request.params.teamName, host);
        if (!teamName.valid) {
          return sendBadRequest(reply, teamName.error);
        }
        if (!feature) {
          return sendUnavailable(reply);
        }
        const metrics = await feature.getMetrics({ teamName: teamName.value });
        return reply.send({
          teamName: teamName.value,
          generatedAt: host.clock.now().toISOString(),
          queue: feature.getQueueDiagnostics(),
          metrics,
        });
      } catch (error) {
        return sendUnexpectedError(
          reply,
          `Error in GET /api/teams/${request.params.teamName}/member-work-sync/diagnostics:`,
          error,
          host
        );
      }
    }
  );

  app.get<{ Params: { teamName: string } }>(
    MEMBER_WORK_SYNC_METRICS_ROUTE,
    async (request, reply) => {
      try {
        const teamName = validateTeamName(request.params.teamName, host);
        if (!teamName.valid) {
          return sendBadRequest(reply, teamName.error);
        }
        if (!feature) {
          return sendUnavailable(reply);
        }
        return reply.send(await feature.getMetrics({ teamName: teamName.value }));
      } catch (error) {
        return sendUnexpectedError(
          reply,
          `Error in GET /api/teams/${request.params.teamName}/member-work-sync/metrics:`,
          error,
          host
        );
      }
    }
  );

  app.get<{ Params: { teamName: string; memberName: string } }>(
    MEMBER_WORK_SYNC_STATUS_ROUTE,
    async (request, reply) => {
      try {
        const teamName = validateTeamName(request.params.teamName, host);
        if (!teamName.valid) {
          return sendBadRequest(reply, teamName.error);
        }
        const memberName = validateRouteMemberName(request.params.memberName, host);
        if (!memberName.valid) {
          return sendBadRequest(reply, memberName.error);
        }
        if (!feature) {
          return sendUnavailable(reply);
        }
        return reply.send(
          await feature.getStatus({
            teamName: teamName.value,
            memberName: memberName.value,
          })
        );
      } catch (error) {
        return sendUnexpectedError(
          reply,
          `Error in GET /api/teams/${request.params.teamName}/member-work-sync/${request.params.memberName}:`,
          error,
          host
        );
      }
    }
  );

  app.post<{
    Params: { teamName: string; memberName: string };
    Body: { forceNudge?: unknown };
  }>(MEMBER_WORK_SYNC_REFRESH_ROUTE, async (request, reply) => {
    try {
      const teamName = validateTeamName(request.params.teamName, host);
      if (!teamName.valid) {
        return sendBadRequest(reply, teamName.error);
      }
      const memberName = validateRouteMemberName(request.params.memberName, host);
      if (!memberName.valid) {
        return sendBadRequest(reply, memberName.error);
      }
      if (!feature) {
        return sendUnavailable(reply);
      }
      return reply.send(
        await feature.refreshStatus({
          teamName: teamName.value,
          memberName: memberName.value,
          ...(request.body?.forceNudge === true ? { forceNudge: true } : {}),
        })
      );
    } catch (error) {
      return sendUnexpectedError(
        reply,
        `Error in POST /api/teams/${request.params.teamName}/member-work-sync/${request.params.memberName}/refresh:`,
        error,
        host
      );
    }
  });

  app.post<{ Params: { teamName: string }; Body: unknown }>(
    MEMBER_WORK_SYNC_REPORT_ROUTE,
    async (request, reply) => {
      try {
        const teamName = validateTeamName(request.params.teamName, host);
        if (!teamName.valid) {
          return sendBadRequest(reply, teamName.error);
        }
        const normalizedPayload = withRouteTeamName(teamName.value, request.body);
        if (!normalizedPayload.valid) {
          return sendBadRequest(reply, normalizedPayload.error);
        }
        const payload = normalizedPayload.value;
        const memberName = typeof payload.memberName === 'string' ? payload.memberName.trim() : '';
        const state = typeof payload.state === 'string' ? payload.state.trim() : '';
        const agendaFingerprint =
          typeof payload.agendaFingerprint === 'string' ? payload.agendaFingerprint.trim() : '';
        if (!memberName || !state || !agendaFingerprint) {
          return sendBadRequest(reply, 'memberName, state, and agendaFingerprint are required');
        }
        const validatedMemberName = validateMemberName(memberName, host);
        if (!validatedMemberName.valid) {
          return sendBadRequest(reply, validatedMemberName.error);
        }
        if (!isMemberWorkSyncReportState(state)) {
          return sendBadRequest(reply, 'state must be still_working, blocked, or caught_up');
        }
        const taskIds = normalizeTaskIds(payload.taskIds);
        if (!feature) {
          return sendUnavailable(reply);
        }
        return reply.send(
          await feature.report({
            teamName: teamName.value,
            memberName: validatedMemberName.value,
            state,
            agendaFingerprint,
            ...(typeof payload.reportToken === 'string'
              ? { reportToken: payload.reportToken }
              : {}),
            ...(taskIds?.length ? { taskIds } : {}),
            ...(typeof payload.note === 'string' ? { note: payload.note } : {}),
            ...(typeof payload.reportedAt === 'string' ? { reportedAt: payload.reportedAt } : {}),
            ...(typeof payload.leaseTtlMs === 'number' ? { leaseTtlMs: payload.leaseTtlMs } : {}),
            source: 'mcp',
          })
        );
      } catch (error) {
        return sendUnexpectedError(
          reply,
          `Error in POST /api/teams/${request.params.teamName}/member-work-sync/report:`,
          error,
          host
        );
      }
    }
  );
}

function validateTeamName(value: unknown, host: MemberWorkSyncHttpHostPorts): ValidatedIdentifier {
  return toValidatedIdentifier(host.identifiers.validateTeamName(value));
}

function validateRouteMemberName(
  value: unknown,
  host: MemberWorkSyncHttpHostPorts
): ValidatedIdentifier {
  const memberName = typeof value === 'string' ? value.trim() : '';
  if (!memberName) {
    return { valid: false, error: 'memberName is required' };
  }
  return validateMemberName(memberName, host);
}

function validateMemberName(value: string, host: MemberWorkSyncHttpHostPorts): ValidatedIdentifier {
  const result = host.identifiers.validateMemberName(value);
  if (!result.valid) {
    return { valid: false, error: result.error ?? 'Invalid memberName' };
  }
  return { valid: true, value: result.value! };
}

function toValidatedIdentifier(
  result: MemberWorkSyncHttpIdentifierValidationResult
): ValidatedIdentifier {
  if (!result.valid) {
    return { valid: false, error: result.error };
  }
  return { valid: true, value: result.value! };
}

function withRouteTeamName(teamName: string, body: unknown): ReportPayload {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'runtime body must be an object' };
  }
  const payload = body as Record<string, unknown>;
  const bodyTeamName = typeof payload.teamName === 'string' ? payload.teamName.trim() : '';
  if (bodyTeamName && bodyTeamName !== teamName) {
    return { valid: false, error: 'runtime body teamName must match route teamName' };
  }
  return { valid: true, value: { ...payload, teamName } };
}

function isMemberWorkSyncReportState(value: string): value is MemberWorkSyncReportState {
  return value === 'still_working' || value === 'blocked' || value === 'caught_up';
}

function normalizeTaskIds(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((taskId): taskId is string => typeof taskId === 'string')
            .map((taskId) => taskId.trim())
            .filter(Boolean)
        ),
      ]
    : undefined;
}

function sendBadRequest(reply: FastifyReply, error: string | undefined): FastifyReply {
  return reply.status(400).send({ error });
}

function sendUnavailable(reply: FastifyReply): FastifyReply {
  return sendBadRequest(reply, 'Member work sync feature is unavailable');
}

function sendUnexpectedError(
  reply: FastifyReply,
  context: string,
  error: unknown,
  host: MemberWorkSyncHttpHostPorts
): FastifyReply {
  const mapping = host.unexpectedErrors.map(error);
  if (mapping.shouldLog) {
    host.logger.error(context, mapping.logMessage);
  }
  return reply.status(mapping.statusCode).send({ error: mapping.responseMessage });
}
