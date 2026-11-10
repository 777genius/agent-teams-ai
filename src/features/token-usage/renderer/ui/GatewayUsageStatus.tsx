import type { TokenUsageAnalyticsSnapshotDto } from '../../contracts';

interface GatewayUsageStatusProps {
  snapshot: TokenUsageAnalyticsSnapshotDto | null;
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export const GatewayUsageStatus = ({ snapshot, locale, t }: GatewayUsageStatusProps) => {
  if (
    !snapshot ||
    !(
      (snapshot.gatewaySourceCount ?? 0) > 0 ||
      snapshot.sourceCounts.gateway_exact > 0 ||
      snapshot.gatewayLastSuccessfulAt
    )
  )
    return null;

  const successfulAt = snapshot.gatewayLastSuccessfulAt
    ? new Date(snapshot.gatewayLastSuccessfulAt)
    : null;
  const validSuccessfulAt = successfulAt && Number.isFinite(successfulAt.getTime());
  return (
    <p className="text-xs text-text-muted">
      {t('tokenUsage.gateway.dailyGranularity')}{' '}
      {validSuccessfulAt ? (
        <span>
          {t('tokenUsage.gateway.lastSuccessfulImport')}{' '}
          <time dateTime={snapshot.gatewayLastSuccessfulAt}>
            {new Intl.DateTimeFormat(locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'UTC',
            }).format(successfulAt)}{' '}
            UTC
          </time>
        </span>
      ) : (
        t('tokenUsage.gateway.noConfirmedImport')
      )}
    </p>
  );
};
