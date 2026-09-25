// eslint-disable-next-line no-restricted-imports -- Hosted grant fencing is main-process-only.
import type { HostedMutationGrantFence } from '@features/team-message-delivery/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Hosted task command is main-process-only.
import type { HostedTaskMutationCommand } from '@features/team-task-board/main/hosted';
import type { QueryContext } from '@shared/contracts/hosted';

export type ProductTaskRunPin = Readonly<{
  /** Null when Product admitted the write with no eligible run in its own epoch. */
  runId: string | null;
  deploymentId: string;
  bootId: string;
  ownerAuthority: string;
  ownerGeneration: number;
  ownerSessionId: string;
  restoreGeneration: number;
  mountGeneration: number;
}>;

/** Present only when the HTTP composition resolved the live principal behind the grant fence. */
export type HostedTaskMutationRequesterEvidence = Readonly<{
  publicWorkspaceId: string;
  userId: string;
  sessionId: string;
}>;

export interface HostedTaskMutationGrantFence extends HostedMutationGrantFence {
  readonly requester?: HostedTaskMutationRequesterEvidence;
}

export interface HostedTaskBoardProductCommitAuthority {
  /** Re-read Product's current lifecycle/run/member authority at every publication boundary. */
  assertCurrent(
    command: HostedTaskMutationCommand,
    context: QueryContext
  ): Promise<ProductTaskRunPin>;
}

export type ProductTaskGrantEvidence = Readonly<{
  grantRevision: string;
  identityChecksum: string;
  /** Missing only in legacy WAL, which cannot be recovered under Product authority. */
  runPin?: ProductTaskRunPin;
}>;

export function parseProductTaskGrantEvidence(value: unknown): ProductTaskGrantEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-task-board-mutation-grant-evidence-invalid');
  }
  const effect = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(effect).length !== (Object.hasOwn(effect, 'runPin') ? 3 : 2) ||
    !Reflect.ownKeys(effect).every(
      (key) => key === 'grantRevision' || key === 'identityChecksum' || key === 'runPin'
    ) ||
    typeof effect.grantRevision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(effect.grantRevision) ||
    typeof effect.identityChecksum !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(effect.identityChecksum)
  )
    throw new TypeError('hosted-task-board-mutation-grant-evidence-invalid');
  const runPin = Object.hasOwn(effect, 'runPin') ? parseProductTaskRunPin(effect.runPin) : null;
  return Object.freeze({
    grantRevision: effect.grantRevision,
    identityChecksum: effect.identityChecksum,
    ...(runPin ? { runPin } : {}),
  });
}

function parseProductTaskRunPin(value: unknown): ProductTaskRunPin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-task-board-run-pin-invalid');
  }
  const pin = value as Record<string, unknown>;
  const fields = [
    'runId',
    'deploymentId',
    'bootId',
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'restoreGeneration',
    'mountGeneration',
  ];
  if (
    Reflect.ownKeys(pin).length !== fields.length ||
    !Reflect.ownKeys(pin).every((key) => fields.includes(String(key))) ||
    (pin.runId !== null &&
      (typeof pin.runId !== 'string' || !/^run_[0-9a-f]{32}$/u.test(pin.runId))) ||
    typeof pin.deploymentId !== 'string' ||
    !/^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/u.test(pin.deploymentId) ||
    typeof pin.bootId !== 'string' ||
    !/^boot_[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u.test(pin.bootId) ||
    typeof pin.ownerAuthority !== 'string' ||
    pin.ownerAuthority.length === 0 ||
    pin.ownerAuthority.length > 128 ||
    typeof pin.ownerSessionId !== 'string' ||
    pin.ownerSessionId.length === 0 ||
    pin.ownerSessionId.length > 128 ||
    !Number.isSafeInteger(pin.ownerGeneration) ||
    (pin.ownerGeneration as number) < 0 ||
    !Number.isSafeInteger(pin.restoreGeneration) ||
    (pin.restoreGeneration as number) < 0 ||
    !Number.isSafeInteger(pin.mountGeneration) ||
    (pin.mountGeneration as number) < 0
  ) {
    throw new TypeError('hosted-task-board-run-pin-invalid');
  }
  return Object.freeze({
    runId: pin.runId,
    deploymentId: pin.deploymentId,
    bootId: pin.bootId,
    ownerAuthority: pin.ownerAuthority,
    ownerGeneration: pin.ownerGeneration as number,
    ownerSessionId: pin.ownerSessionId,
    restoreGeneration: pin.restoreGeneration as number,
    mountGeneration: pin.mountGeneration as number,
  });
}

export function sameProductTaskRunPin(
  left: ProductTaskRunPin | undefined,
  right: ProductTaskRunPin | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.runId === right.runId &&
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    left.ownerAuthority === right.ownerAuthority &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ownerSessionId === right.ownerSessionId &&
    left.restoreGeneration === right.restoreGeneration &&
    left.mountGeneration === right.mountGeneration
  );
}

export class HostedTaskBoardMutationGrantAuthority {
  private readonly fences = new WeakMap<QueryContext, HostedMutationGrantFence>();
  private readonly runPins = new WeakMap<QueryContext, ProductTaskRunPin>();

  constructor(private readonly current: HostedTaskBoardProductCommitAuthority) {}

  bind(context: QueryContext, fence: HostedMutationGrantFence): void {
    if (typeof fence?.revalidate !== 'function')
      throw new TypeError('hosted-task-board-mutation-grant-fence-invalid');
    const effect = parseProductTaskGrantEvidence(fence.ownerEffectFence);
    if (effect.runPin !== undefined)
      throw new TypeError('hosted-task-board-mutation-grant-fence-invalid');
    this.fences.set(
      context,
      Object.freeze({
        ownerEffectFence: effect,
        revalidate: fence.revalidate.bind(fence),
      })
    );
  }

  async assertCurrent(command: HostedTaskMutationCommand, context: QueryContext): Promise<void> {
    const fence = this.fences.get(context);
    if (!fence || !(await fence.revalidate())) throw new Error('hosted-task-board-grant-stale');
    const runPin = parseProductTaskRunPin(await this.current.assertCurrent(command, context));
    if (context.signal.aborted || !(await fence.revalidate())) {
      throw new Error('hosted-task-board-grant-stale');
    }
    const pinned = this.runPins.get(context);
    if (pinned && !sameProductTaskRunPin(pinned, runPin)) {
      throw new Error('hosted-task-board-run-pin-stale');
    }
    this.runPins.set(context, runPin);
  }

  release(context: QueryContext): void {
    this.fences.delete(context);
    this.runPins.delete(context);
  }

  evidenceFor(context: QueryContext): ProductTaskGrantEvidence | null {
    const fence = this.fences.get(context);
    const runPin = this.runPins.get(context);
    return fence && runPin ? Object.freeze({ ...fence.ownerEffectFence, runPin }) : null;
  }
}
