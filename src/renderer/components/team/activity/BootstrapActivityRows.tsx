import { useAppTranslation } from '@features/localization/renderer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { MoveRight } from 'lucide-react';

import type { JSX, ReactNode } from 'react';

const RecipientRoute = ({
  show,
  children,
}: {
  show: boolean;
  children: ReactNode;
}): JSX.Element | null => {
  if (!show) {
    return null;
  }
  return (
    <>
      <MoveRight size={10} style={{ color: CARD_ICON_MUTED }} className="shrink-0" />
      {children}
    </>
  );
};

export const BootstrapSystemRow = ({
  teamName,
  eventKind,
  senderName,
  recipientName,
  runtime,
  senderColor,
  recipientColor,
  isLight,
  timestamp,
  onMemberNameClick,
  showRecipientRoute = true,
}: {
  teamName: string;
  eventKind: 'start' | 'restart';
  senderName: string;
  recipientName: string;
  runtime?: string;
  senderColor?: string;
  recipientColor?: string;
  isLight: boolean;
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
  showRecipientRoute?: boolean;
}): JSX.Element => {
  const { t } = useAppTranslation('team');
  const isRestart = eventKind === 'restart';
  return (
    <div className="flex items-center gap-2 px-3 py-2" style={{ opacity: 0.82 }}>
      <span
        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${
          isRestart ? 'bg-amber-500/12 text-amber-300' : 'bg-sky-500/12 text-sky-300'
        }`}
      >
        {isRestart ? t('activity.badges.restart') : t('activity.badges.start')}
      </span>
      <MemberBadge
        name={senderName}
        color={senderColor}
        teamName={teamName}
        isLight={isLight}
        variant="text"
        hideAvatar
        onClick={onMemberNameClick}
      />
      <RecipientRoute show={showRecipientRoute}>
        <MemberBadge
          name={recipientName}
          color={recipientColor}
          teamName={teamName}
          isLight={isLight}
          variant="text"
          hideAvatar
          onClick={onMemberNameClick}
        />
      </RecipientRoute>
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: CARD_ICON_MUTED }}>
        {runtime ||
          (isRestart ? t('activity.bootstrap.restarting') : t('activity.bootstrap.starting'))}
      </span>
      <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
        {timestamp}
      </span>
    </div>
  );
};

export const BootstrapAcknowledgementRow = ({
  teamName,
  senderName,
  recipientName,
  senderColor,
  recipientColor,
  isLight,
  timestamp,
  onMemberNameClick,
  showRecipientRoute = true,
}: {
  teamName: string;
  senderName: string;
  recipientName: string;
  senderColor?: string;
  recipientColor?: string;
  isLight: boolean;
  timestamp: string;
  onMemberNameClick?: (memberName: string) => void;
  showRecipientRoute?: boolean;
}): JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="flex items-center gap-2 px-3 py-2" style={{ opacity: 0.72 }}>
      <span className="bg-emerald-500/12 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-emerald-300">
        {t('activity.badges.bootstrap')}
      </span>
      <MemberBadge
        name={senderName}
        color={senderColor}
        teamName={teamName}
        isLight={isLight}
        variant="text"
        hideAvatar
        onClick={onMemberNameClick}
      />
      <RecipientRoute show={showRecipientRoute}>
        <MemberBadge
          name={recipientName}
          color={recipientColor}
          teamName={teamName}
          isLight={isLight}
          variant="text"
          hideAvatar
          onClick={onMemberNameClick}
        />
      </RecipientRoute>
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: CARD_ICON_MUTED }}>
        {t('activity.bootstrap.acknowledged')}
      </span>
      <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
        {timestamp}
      </span>
    </div>
  );
};
