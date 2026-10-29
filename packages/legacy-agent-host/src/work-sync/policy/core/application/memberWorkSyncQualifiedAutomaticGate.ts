import type { MemberWorkSyncStatus } from '../../contracts/index.js';
import type { MemberWorkSyncUseCaseDeps } from './ports.js';

export async function rejectQualifiedAutomaticWorkSyncIfClosed(
  deps: MemberWorkSyncUseCaseDeps,
  status: MemberWorkSyncStatus
): Promise<{ planned: false; code: 'member_stopped' } | null> {
  const liveControl = await deps.runtimeTicketAdmission?.readLiveControl?.({
    teamName: status.teamName,
    memberName: status.memberName,
  });
  if (!liveControl?.handshakeCompleted) {
    return null;
  }
  if (liveControl.stopped || status.recoveryHealth?.controlRevision == null) {
    return { planned: false, code: 'member_stopped' };
  }
  return null;
}
