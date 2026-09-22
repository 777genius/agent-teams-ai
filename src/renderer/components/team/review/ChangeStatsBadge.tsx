interface ChangeStatsBadgeProps {
  linesAdded: number;
  linesRemoved: number;
  className?: string;
}

export const ChangeStatsBadge = ({
  linesAdded,
  linesRemoved,
  className = '',
}: ChangeStatsBadgeProps) => {
  if (linesAdded === 0 && linesRemoved === 0) return null;

  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] ${className}`}>
      {linesAdded > 0 && <span className="text-green-400">+{linesAdded}</span>}
      {linesRemoved > 0 && <span className="text-red-400">-{linesRemoved}</span>}
    </span>
  );
};
