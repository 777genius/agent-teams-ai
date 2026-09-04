import type { WorkspaceTrustProjectStatus } from '../../contracts';

export type WorkspaceTrustDisplayStatus = WorkspaceTrustProjectStatus | 'checking';

export function shouldShowWorkspaceTrustLaunchNotice(status: WorkspaceTrustDisplayStatus): boolean {
  return status === 'untrusted' || status === 'unknown';
}
