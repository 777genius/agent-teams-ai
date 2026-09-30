import type {
  HostedAuthenticationContext,
  HostedWorkspaceAccessService,
  HostedWorkspaceGrantSetFence,
} from '../../../../core/application';
import type { HostedHttpRequest } from '../../../../core/domain';

interface EventStreamRequestFence {
  readonly authenticatedSessionId: NonNullable<
    HostedAuthenticationContext['authenticatedSessionId']
  >;
  readonly userId: HostedAuthenticationContext['principal']['userId'];
  readonly role: HostedAuthenticationContext['principal']['role'];
  readonly workspaceGrants: HostedWorkspaceGrantSetFence;
}

export class HostedEventStreamRequestFenceRegistry {
  private readonly fences = new WeakMap<object, EventStreamRequestFence>();

  constructor(private readonly workspaceAccess: HostedWorkspaceAccessService) {}

  async isCurrent(
    request: HostedHttpRequest,
    context: HostedAuthenticationContext | null
  ): Promise<boolean> {
    if (context === null || context.authenticatedSessionId === undefined) return false;
    const existing = this.fences.get(request);
    if (existing === undefined) return this.capture(request, context);
    if (
      context.authenticatedSessionId !== existing.authenticatedSessionId ||
      context.principal.userId !== existing.userId ||
      context.principal.role !== existing.role
    ) {
      return false;
    }
    return this.workspaceAccess
      .revalidateWorkspaceGrantSetFence(existing.workspaceGrants)
      .catch(() => false);
  }

  private async capture(
    request: HostedHttpRequest,
    context: HostedAuthenticationContext
  ): Promise<boolean> {
    if (context.authenticatedSessionId === undefined) return false;
    try {
      this.fences.set(
        request,
        Object.freeze({
          authenticatedSessionId: context.authenticatedSessionId,
          userId: context.principal.userId,
          role: context.principal.role,
          workspaceGrants: await this.workspaceAccess.captureWorkspaceGrantSetFence(
            context.principal.userId
          ),
        })
      );
      return true;
    } catch {
      return false;
    }
  }
}
