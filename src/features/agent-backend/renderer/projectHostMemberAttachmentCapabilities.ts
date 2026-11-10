import type { BackendRosterConfiguration } from '../contracts/roster';
import type { HostTeamRuntimeState } from './createHostTeamLifecycle';
import type { TeamMemberSnapshot } from '@shared/types';

/** The caller has fenced this active roster against its product snapshot. */
export function projectHostMemberAttachmentCapabilities(
  members: readonly TeamMemberSnapshot[],
  configuration: BackendRosterConfiguration,
  state: HostTeamRuntimeState | null
): TeamMemberSnapshot[] {
  return members.map((member) => {
    const product = { ...member };
    delete product.nativeInboxAttachmentsSupported;
    delete product.nativeInboxTextAttachmentsSupported;
    if (product.removedAt || !state) return product;
    const configured = configuration.members.filter((row) => row.name === product.name);
    if (configured.length !== 1 || configured[0].role !== 'member') return product;
    const memberId = configured[0].memberId;
    if (state.unknownMembers.includes(memberId)) return product;
    const captures = state.launch.members.filter((row) => row.memberId === memberId);
    if (captures.length !== 1) return product;
    const capture = captures[0];
    if (
      capture.generation === null ||
      capture.status !== 'ready' ||
      capture.nativeReady !== true ||
      capture.usable !== true ||
      capture.controlAvailable !== true ||
      capture.noAllocation !== false
    )
      return product;
    const sessions = state.sessions.filter(
      (row) => row.memberId === memberId && row.generation === capture.generation
    );
    if (sessions.length !== 1) return product;
    const session = sessions[0];
    if (
      session.attached !== true ||
      session.nativeReady !== true ||
      session.sealed !== false ||
      session.custody !== 'owned' ||
      session.phase !== 'allocated' ||
      !session.attachmentCapabilities
    )
      return product;
    return {
      ...product,
      nativeInboxAttachmentsSupported: session.attachmentCapabilities.images === true,
      nativeInboxTextAttachmentsSupported:
        session.attachmentCapabilities.images === true &&
        session.attachmentCapabilities.textFiles === true,
    };
  });
}
