import {
  assertBackendRequestGuard,
  BackendRoutingError,
  captureBackendPayload,
} from '../../application/backendBinding';
import { HostClientError } from '../../infrastructure/selectedHostProfile';
import { projectBackendResult } from '../output/projectBackendResult';

import { isBackendReviewOperation } from './reviewValues';
import { parseBackendOperation } from './validateBackendOperation';

import type {
  BackendHostRecoveryRequest,
  BackendHostRecoveryResult,
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../contracts/operations';
import type { BackendRequestGuard } from '../../application/backendBinding';
import type { BackendOwnerRouter } from '../../application/BackendOwnerRouter';
import type { CapturedRuntimeReadinessTarget, LocalModelReadinessContext } from '../../infrastructure/CapturedLocalModelReadiness';
import type { CapturedRosterCommands } from '../../infrastructure/CapturedRosterCommands';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

/** Finite app conversation; wire method names and captured binding stay main-owned. */
export class BackendOperationsFacade {
  constructor(
    private readonly router: Pick<BackendOwnerRouter, 'request' | 'lookup'> &
      Partial<Pick<BackendOwnerRouter, 'requestPair'>>,
    private readonly rosterCommands?: CapturedRosterCommands,
    private readonly recoverHost?: (
      request: BackendHostRecoveryRequest, guard?: BackendRequestGuard
    ) => Promise<BackendHostRecoveryResult>
  ) {}

  validate(value: unknown): BackendOperationRequest {
    return parseBackendOperation(value);
  }

  async invoke(value: unknown, guard?: BackendRequestGuard, readiness?: LocalModelReadinessContext,
    target?: CapturedRuntimeReadinessTarget): Promise<BackendOperationResult> {
    let request: BackendOperationRequest;
    try {
      request = this.validate(value);
    } catch {
      return { ok: false, code: 'invalid', outcome: 'not-dispatched' };
    }
    try {
      assertBackendRequestGuard(guard);
      if (
        this.rosterCommands &&
        (request.operation === 'team.roster.replace' || request.operation === 'team.roster.read')
      )
        return await this.rosterCommands.invoke(request, guard, (original) =>
          this.dispatch(original, guard)
        );
      return await this.dispatch(request, guard, readiness, target);
    } catch (error) {
      return this.failure(error);
    }
  }

  private async dispatch(
    request: BackendOperationRequest,
    guard?: BackendRequestGuard,
    readiness?: LocalModelReadinessContext,
    target?: CapturedRuntimeReadinessTarget
  ): Promise<BackendOperationResult> {
    try {
      assertBackendRequestGuard(guard);
      if (readiness && request.operation !== 'team.launch.probe.start')
        throw new BackendRoutingError('invalid-binding');
      if (target && request.operation !== 'runtime.open') throw new BackendRoutingError('invalid-binding');
      if (request.operation === 'host.recovery.capture' || request.operation === 'host.recovery.start') {
        if (!this.recoverHost) throw new BackendRoutingError('unavailable');
        const result = await this.recoverHost(request, guard);
        assertBackendRequestGuard(guard, 'unknown');
        const keys = Object.keys(result);
        if (result.phase === 'ready' && keys.length === 1 && keys[0] === 'phase')
          return { ok: true, value: { phase: 'ready' } };
        if (request.operation === 'host.recovery.capture' && result.phase === 'captured' &&
          keys.length === 2 && keys.includes('phase') && keys.includes('capability') &&
          typeof result.capability === 'string' &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.capability))
          return { ok: true, value: { phase: 'captured', capability: result.capability } };
        throw new BackendRoutingError('hold', 'unknown');
      }
      let raw: JsonValue;
      if (request.operation === 'crossTeam.send') {
        if (!this.router.requestPair) throw new BackendRoutingError('unavailable');
        raw = await this.router.requestPair(request.handle, request.payload.target, {
          commandId: request.commandId,
          method: 'team.crossTeam.send',
          payload: captureBackendPayload(request.payload, 'team.crossTeam.send'),
          ...(guard ? { guard } : {}),
        });
      } else if (request.operation === 'command.lookup') {
        raw = await this.router.lookup(
          request.handle,
          request.commandId,
          'team.lookup',
          ...(guard ? [guard] : [])
        );
      } else {
        const group = request.operation.startsWith('group.');
        const process = request.operation.startsWith('process.');
        const crossTeam = request.operation.startsWith('crossTeam.');
        const review = isBackendReviewOperation(request.operation);
        const runtime = request.operation.startsWith('runtime.');
        const memberAction = request.operation.startsWith('team.member.action');
        const launch = request.operation.startsWith('team.launch.');
        const activity =
          request.operation === 'team.activity.logs.read' ||
          request.operation === 'team.activity.stats.read' ||
          request.operation === 'team.lead.activity.read' ||
          request.operation === 'team.lead.context.read';
        const changes = request.operation === 'team.changes.read';
        const roster =
          request.operation.startsWith('team.roster.') ||
          request.operation.startsWith('team.lifecycle.') ||
          request.operation.startsWith('team.queue.');
        const upload = request.operation === 'attachment.upload';
        const attachment =
          upload ||
          request.operation === 'task.attachment.read' ||
          request.operation === 'message.attachment.read' ||
          request.operation === 'message.attachments.read';
        const read =
          request.operation === 'task.get' ||
          request.operation === 'tasks.list' ||
          request.operation === 'team.snapshot' ||
          request.operation === 'team.messages.page';
        const method =
          group || process || crossTeam
            ? `team.${request.operation}`
            : attachment
              ? `team.${request.operation}`
              : review
                ? `team.${request.operation}`
                : runtime || launch || memberAction || changes || roster || activity
                  ? request.operation
                  : read
                    ? request.operation === 'team.snapshot' || request.operation === 'team.messages.page'
                      ? request.operation
                      : request.operation === 'task.get'
                        ? 'team.task.get'
                        : 'team.tasks.list'
                    : 'team.execute';
        raw = await this.router.request(request.handle, {
          commandId: request.commandId,
          method,
          payload: (group ||
          crossTeam ||
          process ||
          review ||
          runtime ||
          launch ||
          memberAction ||
          changes ||
          read ||
          roster ||
          attachment ||
          activity
            ? request.payload
            : { operation: request.operation, payload: request.payload }) as JsonValue,
          control:
            (group &&
              ['group.list', 'group.reaction.read', 'group.lookup'].includes(request.operation)) ||
            (memberAction && request.operation !== 'team.member.action.execute') ||
            crossTeam ||
            process ||
            (review && request.operation !== 'review.invoke') ||
            read ||
            activity ||
            (attachment && !upload) ||
            changes ||
            request.operation === 'team.roster.read' ||
            request.operation === 'team.roster.lookup' ||
            request.operation === 'team.launch.read' ||
            request.operation === 'team.launch.configuration.read' ||
            request.operation === 'team.launch.model.configuration.read' ||
            request.operation === 'team.launch.restorations.read' ||
            request.operation === 'team.launch.resume.prepare' ||
            request.operation === 'team.launch.probe.read' ||
            request.operation === 'team.launch.probe.cancel' ||
            (runtime &&
              request.operation !== 'runtime.open' &&
              request.operation !== 'runtime.dispatch' &&
              request.operation !== 'runtime.restore'),
          ...(guard ? { guard } : {}),
          ...(readiness ? { localModelReadinessContext: readiness } : {}),
          ...(target ? { localModelReadinessTarget: structuredClone(target) } : {}),
        });
      }
      assertBackendRequestGuard(guard, 'unknown');
      return projectBackendResult(request, raw);
    } catch (error) {
      return this.failure(error);
    }
  }

  private failure(error: unknown): Extract<BackendOperationResult, { ok: false }> {
    if (error instanceof BackendRoutingError)
      return {
        ok: false,
        code:
          error.code === 'unavailable' ||
          error.code === 'shutting-down' ||
          error.code === 'forbidden'
            ? error.code
            : error.code === 'binding-conflict'
              ? 'conflict'
              : 'hold',
        outcome: error.outcome,
      };
    if (error instanceof HostClientError)
      return {
        ok: false,
        code:
          error.code === 'capacity-exceeded'
            ? 'busy'
            : error.code === 'shutting-down' || error.code === 'transport-closed'
              ? 'unavailable'
              : 'hold',
        outcome: error.outcome,
      };
    // Includes malformed host projection after a potential mutation: never claim rejection.
    return { ok: false, code: 'hold', outcome: 'unknown' };
  }
}
