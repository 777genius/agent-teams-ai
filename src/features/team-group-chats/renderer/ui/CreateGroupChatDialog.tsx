import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MemberCard } from '@renderer/components/team/members/MemberCard';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { buildMemberAvatarMap, buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { resolveMemberRuntimeSummary } from '@renderer/utils/memberRuntimeSummary';

import type { GroupChatCreateRequest, TeamGroupChatDTO } from '../../contracts';
import type { ResolvedTeamMember } from '@shared/types';

interface Props {
  teamName: string;
  members: readonly ResolvedTeamMember[];
  isTeamAlive?: boolean;
  onClose: () => void;
  onCreated: (group: TeamGroupChatDTO) => void;
  create: (request: GroupChatCreateRequest) => Promise<TeamGroupChatDTO>;
}
export const CreateGroupChatDialog = ({
  teamName,
  members,
  isTeamAlive,
  onClose,
  onCreated,
  create,
}: Props) => {
  const { t } = useAppTranslation('team');
  const [id, setId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [autoIncludeNewMembers, setAuto] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<GroupChatCreateRequest | null>(null);
  const avatars = buildMemberAvatarMap(members);
  const colors = buildMemberColorMap(members);
  const selected = members.filter((member) => !excluded.has(member.name));
  const submit = async () => {
    if (pending) return;
    const request = submitted ?? {
      teamName,
      id,
      name: name.trim(),
      selectedMemberNames: selected.map((member) => member.name),
      excludedMemberNames: [...excluded],
      autoIncludeNewMembers,
    };
    setSubmitted(request);
    setPending(true);
    setError(null);
    try {
      const group = await create(request);
      onCreated(group);
      onClose();
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? cause.code : null;
      if (code === 'invalid-input' || code === 'invalid-members' || code === 'minimum-members') {
        setSubmitted(null);
        setId(crypto.randomUUID());
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg" data-testid="create-group-chat-dialog">
        <DialogHeader>
          <DialogTitle>{t('messages.groups.create')}</DialogTitle>
          <DialogDescription>{t('messages.groups.description')}</DialogDescription>
        </DialogHeader>
        <Label htmlFor={`group-name-${id}`} className="space-y-1 text-sm">
          {t('messages.groups.name')}
          <Input
            id={`group-name-${id}`}
            value={name}
            maxLength={80}
            disabled={submitted !== null}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </Label>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {members.map((member) => (
            <Label
              htmlFor={`group-member-${id}-${encodeURIComponent(member.name)}`}
              key={member.name}
              className="flex cursor-pointer items-center gap-3 rounded px-2 hover:bg-[var(--color-surface-raised)] focus-within:bg-[var(--color-surface-raised)] focus-within:ring-1 focus-within:ring-blue-500/50"
            >
              <Checkbox
                id={`group-member-${id}-${encodeURIComponent(member.name)}`}
                aria-label={member.name}
                checked={!excluded.has(member.name)}
                disabled={submitted !== null}
                onCheckedChange={(checked) =>
                  setExcluded((previous) => {
                    const next = new Set(previous);
                    if (checked) next.delete(member.name);
                    else next.add(member.name);
                    return next;
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <MemberCard
                  passive
                  fullBleedSurface={false}
                  member={member}
                  memberColor={colors.get(member.name) ?? 'blue'}
                  avatarUrl={avatars.get(member.name)}
                  runtimeSummary={resolveMemberRuntimeSummary(member, undefined, undefined)}
                  isTeamAlive={isTeamAlive}
                />
              </span>
            </Label>
          ))}
        </div>
        <Label htmlFor={`group-auto-${id}`} className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            id={`group-auto-${id}`}
            checked={autoIncludeNewMembers}
            disabled={submitted !== null}
            onCheckedChange={(checked) => setAuto(checked === true)}
          />
          {t('messages.groups.autoInclude')}
        </Label>
        <p className="text-xs text-[var(--color-text-muted)]">{t('messages.groups.minimum')}</p>
        {error ? (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        ) : null}
        <Button
          disabled={pending || !name.trim() || selected.length < 2}
          onClick={() => void submit()}
        >
          {pending
            ? t('messages.groups.creating')
            : submitted
              ? t('messages.groups.retryCreate')
              : t('messages.groups.create')}
        </Button>
      </DialogContent>
    </Dialog>
  );
};
