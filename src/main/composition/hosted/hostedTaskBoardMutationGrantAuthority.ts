// eslint-disable-next-line no-restricted-imports -- Hosted grant fencing is main-process-only.
import type { HostedMutationGrantFence } from '@features/team-message-delivery/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Hosted task command is main-process-only.
import type { HostedTaskMutationCommand } from '@features/team-task-board/main/hosted';
import type { QueryContext } from '@shared/contracts/hosted';

export interface HostedTaskBoardProductCommitAuthority {
  /** Re-read Product's current lifecycle/run/member authority at every publication boundary. */
  assertCurrent(command: HostedTaskMutationCommand, context: QueryContext): Promise<void>;
}

export type ProductTaskGrantEvidence = Readonly<{
  grantRevision: string;
  identityChecksum: string;
}>;

export function parseProductTaskGrantEvidence(value: unknown): ProductTaskGrantEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-task-board-mutation-grant-evidence-invalid');
  }
  const effect = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(effect).length !== 2 ||
    !Reflect.ownKeys(effect).every(
      (key) => key === 'grantRevision' || key === 'identityChecksum'
    ) ||
    typeof effect.grantRevision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(effect.grantRevision) ||
    typeof effect.identityChecksum !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(effect.identityChecksum)
  )
    throw new TypeError('hosted-task-board-mutation-grant-evidence-invalid');
  return Object.freeze({
    grantRevision: effect.grantRevision,
    identityChecksum: effect.identityChecksum,
  });
}

export class HostedTaskBoardMutationGrantAuthority {
  private readonly fences = new WeakMap<QueryContext, HostedMutationGrantFence>();

  constructor(private readonly current: HostedTaskBoardProductCommitAuthority) {}

  bind(context: QueryContext, fence: HostedMutationGrantFence): void {
    if (typeof fence?.revalidate !== 'function')
      throw new TypeError('hosted-task-board-mutation-grant-fence-invalid');
    const effect = parseProductTaskGrantEvidence(fence.ownerEffectFence);
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
    await this.current.assertCurrent(command, context);
    if (context.signal.aborted || !(await fence.revalidate())) {
      throw new Error('hosted-task-board-grant-stale');
    }
  }

  release(context: QueryContext): void {
    this.fences.delete(context);
  }

  evidenceFor(context: QueryContext): ProductTaskGrantEvidence | null {
    return this.fences.get(context)?.ownerEffectFence ?? null;
  }
}
