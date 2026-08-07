import {
  parseActorId,
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
  type Revision,
} from '@shared/contracts/hosted';

import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  type HostedLifecycleCommand,
  type HostedLifecycleCommandAction,
  type HostedLifecycleCommandConflict,
  type HostedLifecycleCommandExecutionResult,
  type HostedLifecycleCommandNotFound,
  type HostedLifecycleCommandPublicResult,
  type HostedLifecycleCommandUnavailable,
  type HostedLifecycleConflictReason,
  parseHostedLifecycleCommand,
  parseHostedLifecycleCommandPublicResult,
} from '../../contracts/hosted-lifecycle-commands';

import type {
  HostedLifecycleCommandAuthorization,
  HostedLifecycleCommandAuthorizationResult,
  HostedLifecycleCommandGatewayExecutionResult,
  HostedLifecycleCommandGatewayPort,
  HostedLifecycleCommandRevalidationResult,
} from './ports/HostedLifecycleCommandGatewayPort';

const GRANT_ID_PATTERN = /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const AUTHORIZATION_GENERATION_PATTERN =
  /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function unavailable(retryAfterMs: number | null = null): HostedLifecycleCommandUnavailable {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'unavailable',
    retryAfterMs,
  });
}

function contextIsOpen(context: QueryContext, now: () => number): boolean {
  try {
    const nowMs = now();
    return (
      context.signal instanceof AbortSignal &&
      !context.signal.aborted &&
      Number.isSafeInteger(context.deadlineAtMs) &&
      Number.isSafeInteger(nowMs) &&
      nowMs >= 0 &&
      nowMs < context.deadlineAtMs
    );
  } catch {
    return false;
  }
}

function snapshotAuthorization(
  authorization: HostedLifecycleCommandAuthorization,
  context: QueryContext,
  command: HostedLifecycleCommand
): HostedLifecycleCommandAuthorization | null {
  try {
    if (
      typeof authorization !== 'object' ||
      authorization === null ||
      Reflect.ownKeys(authorization).length !== 9
    ) {
      return null;
    }
    const grantId = authorization.grantId;
    const authorizationGeneration = authorization.authorizationGeneration;
    const deploymentId = parseDeploymentId(authorization.deploymentId);
    const bootId = parseBootId(authorization.bootId);
    const resourceRevision = parseRevision(authorization.resourceRevision);
    const actorId = parseActorId(authorization.actorId);
    const workspaceId = parseWorkspaceId(authorization.workspaceId);
    const teamId = parseTeamId(authorization.teamId);
    const restoreGeneration = authorization.restoreGeneration;
    if (
      !GRANT_ID_PATTERN.test(grantId) ||
      !AUTHORIZATION_GENERATION_PATTERN.test(authorizationGeneration) ||
      deploymentId !== context.deploymentId ||
      bootId !== context.bootId ||
      actorId !== context.actorId ||
      workspaceId !== command.workspaceId ||
      teamId !== command.teamId ||
      typeof restoreGeneration !== 'number' ||
      !Number.isSafeInteger(restoreGeneration) ||
      restoreGeneration < 0
    ) {
      return null;
    }
    return Object.freeze({
      grantId,
      authorizationGeneration,
      deploymentId,
      bootId,
      resourceRevision,
      actorId,
      workspaceId,
      teamId,
      restoreGeneration,
    });
  } catch {
    return null;
  }
}

function sameAuthorization(
  left: HostedLifecycleCommandAuthorization,
  right: HostedLifecycleCommandAuthorization
): boolean {
  return (
    left.grantId === right.grantId &&
    left.authorizationGeneration === right.authorizationGeneration &&
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    left.resourceRevision === right.resourceRevision &&
    left.actorId === right.actorId &&
    left.workspaceId === right.workspaceId &&
    left.teamId === right.teamId &&
    left.restoreGeneration === right.restoreGeneration
  );
}

function conflict(
  command: HostedLifecycleCommand,
  reason: HostedLifecycleConflictReason,
  currentRevision: Revision | null
): HostedLifecycleCommandConflict {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'conflict',
    action: command.action,
    commandId: command.commandId,
    workspaceId: command.workspaceId,
    teamId: command.teamId,
    reason,
    currentRevision,
  });
}

function notFound(command: HostedLifecycleCommand): HostedLifecycleCommandNotFound {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'not_found',
    action: command.action,
    commandId: command.commandId,
    workspaceId: command.workspaceId,
    teamId: command.teamId,
  });
}

function mapAuthorityOutcome(
  command: HostedLifecycleCommand,
  outcome: Exclude<
    HostedLifecycleCommandAuthorizationResult | HostedLifecycleCommandRevalidationResult,
    { readonly kind: 'authorized' | 'valid' }
  >
): HostedLifecycleCommandPublicResult {
  if (outcome.kind === 'conflict') {
    return conflict(command, outcome.reason, outcome.currentRevision);
  }
  if (outcome.kind === 'not_found') return notFound(command);
  return unavailable(outcome.retryAfterMs);
}

function resultMatchesCommand(
  result: HostedLifecycleCommandPublicResult,
  command: HostedLifecycleCommand,
  authorization: HostedLifecycleCommandAuthorization
): boolean {
  if (result.kind === 'unavailable') return true;
  if (
    result.action !== command.action ||
    result.commandId !== command.commandId ||
    result.workspaceId !== command.workspaceId ||
    result.teamId !== command.teamId
  ) {
    return false;
  }
  if (result.kind === 'accepted' || result.kind === 'idempotent_replay') {
    if (result.resourceRevision !== authorization.resourceRevision) return false;
    return command.action === 'launch' || result.runId === command.runId;
  }
  return true;
}

export class ExecuteHostedLifecycleCommand {
  constructor(
    private readonly gateway: HostedLifecycleCommandGatewayPort,
    private readonly now: () => number = Date.now
  ) {}

  async execute(
    action: HostedLifecycleCommandAction,
    body: unknown,
    context: QueryContext
  ): Promise<HostedLifecycleCommandExecutionResult> {
    const parsed = parseHostedLifecycleCommand(action, body);
    if (!parsed.ok) {
      return Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        kind: 'invalid_request',
      });
    }
    const command = parsed.value;
    if (!contextIsOpen(context, this.now)) return unavailable();

    try {
      const admission = await this.gateway.authorize(command, context);
      if (!contextIsOpen(context, this.now)) return unavailable();
      if (admission.kind !== 'authorized') return mapAuthorityOutcome(command, admission);
      const initialAuthorization = snapshotAuthorization(admission.authorization, context, command);
      if (initialAuthorization === null) return unavailable();
      if (initialAuthorization.resourceRevision !== command.expectedRevision) {
        return conflict(command, 'stale_revision', initialAuthorization.resourceRevision);
      }

      const precommit = await this.gateway.revalidate(command, initialAuthorization, context);
      if (!contextIsOpen(context, this.now)) return unavailable();
      if (precommit.kind !== 'valid') return mapAuthorityOutcome(command, precommit);
      const precommitAuthorization = snapshotAuthorization(
        precommit.authorization,
        context,
        command
      );
      if (
        precommitAuthorization === null ||
        !sameAuthorization(precommitAuthorization, initialAuthorization)
      ) {
        return conflict(command, 'authorization_changed', null);
      }

      // The injected gateway owns the atomic fence comparison and command commit. This process has
      // no lifecycle store and performs no provider/process operation.
      const executed = await this.gateway.execute(command, precommitAuthorization, context);
      if (!contextIsOpen(context, this.now)) return unavailable();
      return await this.finish(command, precommitAuthorization, executed, context);
    } catch {
      return unavailable();
    }
  }

  private async finish(
    command: HostedLifecycleCommand,
    precommitAuthorization: HostedLifecycleCommandAuthorization,
    executed: HostedLifecycleCommandGatewayExecutionResult,
    context: QueryContext
  ): Promise<HostedLifecycleCommandPublicResult> {
    let publicResult: HostedLifecycleCommandPublicResult | null = null;
    const finalAuthorization =
      executed.kind === 'result'
        ? (() => {
            const parsed = parseHostedLifecycleCommandPublicResult(executed.result);
            if (!parsed.ok) return null;
            publicResult = parsed.value;
            return snapshotAuthorization(executed.authorization, context, command);
          })()
        : precommitAuthorization;
    if (finalAuthorization === null) return unavailable();
    if (
      finalAuthorization.grantId !== precommitAuthorization.grantId ||
      finalAuthorization.authorizationGeneration !==
        precommitAuthorization.authorizationGeneration ||
      finalAuthorization.deploymentId !== precommitAuthorization.deploymentId ||
      finalAuthorization.bootId !== precommitAuthorization.bootId ||
      finalAuthorization.actorId !== precommitAuthorization.actorId ||
      finalAuthorization.workspaceId !== precommitAuthorization.workspaceId ||
      finalAuthorization.teamId !== precommitAuthorization.teamId ||
      finalAuthorization.restoreGeneration !== precommitAuthorization.restoreGeneration
    ) {
      return conflict(command, 'authorization_changed', null);
    }
    if (publicResult !== null && !resultMatchesCommand(publicResult, command, finalAuthorization)) {
      return unavailable();
    }

    const finalCheck = await this.gateway.revalidate(command, finalAuthorization, context);
    if (!contextIsOpen(context, this.now)) return unavailable();
    if (finalCheck.kind !== 'valid') return mapAuthorityOutcome(command, finalCheck);
    const finalCheckAuthorization = snapshotAuthorization(
      finalCheck.authorization,
      context,
      command
    );
    if (
      finalCheckAuthorization === null ||
      !sameAuthorization(finalCheckAuthorization, finalAuthorization)
    ) {
      return conflict(command, 'authorization_changed', null);
    }
    return (
      publicResult ?? unavailable(executed.kind === 'unavailable' ? executed.retryAfterMs : null)
    );
  }
}
