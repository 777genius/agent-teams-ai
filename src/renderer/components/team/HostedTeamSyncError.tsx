import { Button } from '@renderer/components/ui/button';

export interface HostedTeamSyncErrorProps {
  readonly retryScheduledInMs: number | null;
  readonly retry: () => void;
}

export const HostedTeamSyncError = ({
  retryScheduledInMs,
  retry,
}: HostedTeamSyncErrorProps): React.JSX.Element => (
  <>
    <p role="alert">Live team data is temporarily unavailable.</p>
    {retryScheduledInMs === null ? null : <p role="status">Retrying automatically.</p>}
    <Button type="button" size="sm" variant="outline" onClick={retry}>
      Retry team data
    </Button>
  </>
);
