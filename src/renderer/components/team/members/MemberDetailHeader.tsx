import { useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { DialogDescription, DialogTitle } from '@renderer/components/ui/dialog';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { agentAvatarUrl, getMemberDotClass, getPresenceLabel } from '@renderer/utils/memberHelpers';
import { Pencil } from 'lucide-react';

import { MemberRoleEditor } from './MemberRoleEditor';

import type { LeadActivityState, ResolvedTeamMember } from '@shared/types';

interface MemberDetailHeaderProps {
  member: ResolvedTeamMember;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  onUpdateRole?: (newRole: string | undefined) => Promise<void> | void;
  updatingRole?: boolean;
}

export const MemberDetailHeader = ({
  member,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  onUpdateRole,
  updatingRole,
}: MemberDetailHeaderProps): React.JSX.Element => {
  const [editing, setEditing] = useState(false);

  const role = member.role || formatAgentRole(member.agentType);
  const presenceLabel = getPresenceLabel(member, isTeamAlive, isTeamProvisioning, leadActivity);
  const dotClass = getMemberDotClass(member, isTeamAlive, isTeamProvisioning, leadActivity);

  const canEditRole =
    member.agentType !== 'team-lead' && !member.removedAt && !isTeamProvisioning && !!onUpdateRole;

  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0">
        <img
          src={agentAvatarUrl(member.name, 96)}
          alt={member.name}
          className="size-12 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
        <span
          className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[var(--color-surface)] ${dotClass}`}
          aria-label={presenceLabel}
        />
      </div>
      <div className="min-w-0 flex-1">
        <DialogTitle className="truncate">{member.name}</DialogTitle>
        <DialogDescription asChild className="mt-1 flex items-center gap-2">
          <div>
            {editing ? (
              <MemberRoleEditor
                currentRole={member.role}
                saving={updatingRole}
                onSave={async (newRole) => {
                  try {
                    await onUpdateRole?.(newRole);
                    setEditing(false);
                  } catch {
                    // stay in editing mode so user can retry
                  }
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <span>{role || 'No role'}</span>
                {canEditRole && (
                  <button
                    type="button"
                    className="inline-flex items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                    onClick={() => setEditing(true)}
                    aria-label="Edit role"
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </>
            )}
            {!editing && (
              <Badge
                variant="secondary"
                className="px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--color-text-muted)]"
              >
                {presenceLabel}
              </Badge>
            )}
          </div>
        </DialogDescription>
      </div>
    </div>
  );
};
