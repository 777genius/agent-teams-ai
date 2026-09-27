import { MemberBadge } from '@renderer/components/team/MemberBadge';

interface ActivitySenderBadgeProps {
  name: string;
  color?: string;
  teamName: string;
  isLight: boolean;
  isWideAgent: boolean;
  hideAvatar: boolean;
  compactHeader: boolean;
  isSlashCommandResult: boolean;
  resultLabel: string;
  disableHoverCard: boolean;
  onMemberNameClick?: (memberName: string) => void;
}

export const ActivitySenderBadge = ({
  name,
  color,
  teamName,
  isLight,
  isWideAgent,
  hideAvatar,
  compactHeader,
  isSlashCommandResult,
  resultLabel,
  disableHoverCard,
  onMemberNameClick,
}: Readonly<ActivitySenderBadgeProps>): React.JSX.Element => {
  const badge = isSlashCommandResult ? (
    <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium tracking-wide text-amber-300">
      {resultLabel}
    </span>
  ) : (
    <MemberBadge
      name={name}
      color={color}
      teamName={teamName}
      isLight={isLight}
      size={isWideAgent ? 'md' : undefined}
      variant="text"
      hideAvatar={hideAvatar || compactHeader}
      onClick={onMemberNameClick}
      disableHoverCard={disableHoverCard}
    />
  );

  return isWideAgent ? (
    <span data-chat-sender="true" className="inline-flex items-center">
      {badge}
    </span>
  ) : (
    badge
  );
};
