import { Button } from '@renderer/components/ui/button';

interface TeamEmptyStateProps {
  canCreate: boolean;
  onCreateTeam: () => void;
}

export const TeamEmptyState = ({
  canCreate,
  onCreateTeam,
}: TeamEmptyStateProps): React.JSX.Element => {
  return (
    <div className="flex size-full items-center justify-center">
      <div className="text-center">
        <p className="text-lg font-medium text-[var(--color-text)]">No teams found</p>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Create a team here to get started. It will show up in the list automatically.
        </p>
        <div className="mt-4">
          <Button size="sm" disabled={!canCreate} onClick={onCreateTeam}>
            Create Team
          </Button>
        </div>
        {!canCreate ? (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Team creation is only available in local Electron mode.
          </p>
        ) : null}
      </div>
    </div>
  );
};
