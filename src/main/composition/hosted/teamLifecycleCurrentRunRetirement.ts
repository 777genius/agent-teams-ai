// eslint-disable-next-line no-restricted-imports -- Bounded server-only lifecycle authority facet.
import { sameOrchestratorLifecycleOwnerBinding } from '@features/team-lifecycle/main/hosted';

import type {
  HostedLifecycleAuthorityEpoch,
  HostedLifecycleCurrentAuthority,
  HostedLifecycleCurrentAuthorityGateway,
  HostedLifecycleCurrentRun,
  HostedLifecycleRunReservationGateway,
} from '@features/internal-storage/contracts';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only lifecycle authority facet.
import type {
  HostedLifecycleCommand,
  HostedLifecycleControlStateResult,
  OrchestratorLifecycleOwnerBinding,
} from '@features/team-lifecycle/main/hosted';
import type { QueryContext, RunId } from '@shared/contracts/hosted';

type Fence = Readonly<{
  publicWorkspaceId?: string;
  runtimeWorkspaceId?: string;
  revalidate(): Promise<boolean>;
}>;

export interface TeamLifecycleCurrentRunRetirementDependencies {
  readonly current: () => HostedLifecycleCurrentAuthorityGateway | null;
  readonly reservations: () => HostedLifecycleRunReservationGateway | null;
  readonly currentOwner: () => OrchestratorLifecycleOwnerBinding | null;
  readonly expectedOwner: OrchestratorLifecycleOwnerBinding;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly fenceForContext: (context: QueryContext) => Fence | null;
  readonly controlState: (
    request: {
      schemaVersion: 1;
      workspaceId: HostedLifecycleCommand['workspaceId'];
      teamId: HostedLifecycleCommand['teamId'];
    },
    context: QueryContext
  ) => Promise<HostedLifecycleControlStateResult>;
}

function sameEpoch(
  left: HostedLifecycleCurrentAuthority | HostedLifecycleCurrentRun,
  right: HostedLifecycleAuthorityEpoch
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    left.ownerAuthority === right.ownerAuthority &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ownerSessionId === right.ownerSessionId &&
    left.restoreGeneration === right.restoreGeneration &&
    left.mountGeneration === right.mountGeneration
  );
}

function sameOwner(
  left: OrchestratorLifecycleOwnerBinding | null,
  right: OrchestratorLifecycleOwnerBinding
): boolean {
  return left !== null && sameOrchestratorLifecycleOwnerBinding(left, right);
}

/** All mutations are private Product calls made from authenticated Owner lifecycle composition. */
export class TeamLifecycleCurrentRunRetirement {
  constructor(private readonly deps: TeamLifecycleCurrentRunRetirementDependencies) {}

  async beforeNonLaunchExecute(
    command: HostedLifecycleCommand,
    context: QueryContext
  ): Promise<boolean> {
    if (command.action === 'launch') return true;
    const current = this.deps.current();
    const reservations = this.deps.reservations();
    const fence = this.deps.fenceForContext(context);
    const binding = this.binding(context);
    if (
      !current ||
      !reservations ||
      !fence ||
      !binding ||
      fence.runtimeWorkspaceId !== command.workspaceId ||
      !(await fence.revalidate())
    )
      return false;
    const [run, reservation, authority] = await Promise.all([
      current.lookupRun(command.runId),
      reservations.lookup(command.runId),
      current.lookupAuthority(context.deploymentId),
    ]);
    if (
      !run ||
      !reservation ||
      !authority ||
      authority.state !== 'active' ||
      !sameEpoch(authority, binding) ||
      !sameEpoch(run, binding) ||
      run.teamId !== command.teamId ||
      reservation.teamId !== command.teamId ||
      reservation.workspaceId !== fence.publicWorkspaceId ||
      reservation.runtimeWorkspaceId !== command.workspaceId ||
      reservation.actorId !== context.actorId ||
      reservation.runId !== command.runId
    )
      return false;
    if (command.action === 'recover') return run.state === 'eligible';
    if (run.state === 'retired') return false;
    const retired = await current.retireRun({ binding, runId: command.runId });
    return retired === 'cleanup_pending' || retired === 'already_pending';
  }

  async beforeLaunch(command: HostedLifecycleCommand, context: QueryContext): Promise<boolean> {
    const current = this.deps.current();
    const binding = this.binding(context);
    if (!current) return true;
    if (!binding) return false;
    const prior = await current.lookupTeamRun({
      deploymentId: context.deploymentId,
      teamId: command.teamId,
    });
    if (!prior) return true;
    if (!sameEpoch(prior, binding)) return false;
    if (!(await this.idleObserved(command, context))) return false;
    if (prior.state === 'eligible') {
      const begun = await current.retireRun({ binding, runId: prior.runId });
      if (begun !== 'cleanup_pending' && begun !== 'already_pending') return false;
    }
    const settled = await current.confirmRunRetired({ binding, runId: prior.runId });
    return settled === 'retired' || settled === 'already_retired';
  }

  async afterTerminalReceipt(
    command: HostedLifecycleCommand & { readonly runId: RunId },
    context: QueryContext
  ): Promise<boolean> {
    const current = this.deps.current();
    const binding = this.binding(context);
    if (!current || !binding || !(await this.idleObserved(command, context))) return false;
    const settled = await current.confirmRunRetired({ binding, runId: command.runId });
    return settled === 'retired' || settled === 'already_retired';
  }

  async retireLostOwner(binding: HostedLifecycleAuthorityEpoch): Promise<void> {
    const current = this.deps.current();
    if (!current) return;
    const authority = await current.lookupAuthority(binding.deploymentId);
    if (!authority || authority.state === 'retired' || !sameEpoch(authority, binding)) return;
    await current.retireAuthority({ binding, expectedRevision: authority.revision });
  }

  capturedBinding(
    deploymentId: QueryContext['deploymentId'],
    bootId: QueryContext['bootId']
  ): HostedLifecycleAuthorityEpoch {
    const owner = this.deps.expectedOwner;
    return {
      deploymentId,
      bootId,
      ownerAuthority: owner.ownerAuthority,
      ownerGeneration: owner.ownerGeneration,
      ownerSessionId: owner.ownerSessionId,
      restoreGeneration: this.deps.restoreGeneration,
      mountGeneration: this.deps.mountGeneration,
    };
  }

  private binding(context: QueryContext): HostedLifecycleAuthorityEpoch | null {
    if (!sameOwner(this.deps.currentOwner(), this.deps.expectedOwner)) return null;
    return this.capturedBinding(context.deploymentId, context.bootId);
  }

  private async idleObserved(
    command: Pick<HostedLifecycleCommand, 'workspaceId' | 'teamId'>,
    context: QueryContext
  ): Promise<boolean> {
    const fence = this.deps.fenceForContext(context);
    if (!fence || fence.runtimeWorkspaceId !== command.workspaceId || !(await fence.revalidate()))
      return false;
    const control = await this.deps.controlState(
      { schemaVersion: 1, workspaceId: command.workspaceId, teamId: command.teamId },
      context
    );
    return (
      this.binding(context) !== null &&
      control.kind === 'control_state' &&
      control.runId === null &&
      control.availableActions.length === 1 &&
      control.availableActions[0] === 'launch'
    );
  }
}
