import { useTeamDisplayLabel } from '@features/team-project-context/renderer';

const BADGE_CLASS =
  'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide';

/** The other team of a cross-team message. A click opens it by its physical name. */
export const CrossTeamTeamBadge = ({
  teamName,
  onClick,
}: {
  teamName: string;
  onClick?: (teamName: string) => void;
}): React.JSX.Element => {
  const label = useTeamDisplayLabel(teamName);
  if (onClick) {
    return (
      <button
        type="button"
        className={BADGE_CLASS}
        data-cross-team-badge={teamName}
        style={{
          backgroundColor: 'rgba(168, 85, 247, 0.15)',
          color: '#c084fc',
          cursor: 'pointer',
          border: 'none',
          padding: '1px 6px',
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClick(teamName);
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      className={BADGE_CLASS}
      data-cross-team-badge={teamName}
      style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#c084fc' }}
    >
      {label}
    </span>
  );
};
