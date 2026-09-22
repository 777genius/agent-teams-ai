import type { CodexRuntimeStatus } from '../../contracts';

export function getCodexRuntimeProgressPercent(
  status: CodexRuntimeStatus | null | undefined
): number | null {
  const reportedPercent = status?.progress?.percent;
  if (typeof reportedPercent === 'number' && Number.isFinite(reportedPercent)) {
    return Math.max(0, Math.min(100, reportedPercent));
  }

  switch (status?.state) {
    case 'checking':
      return 10;
    case 'downloading':
      return 35;
    case 'installing':
      return 90;
    case 'ready':
      return status.progress?.phase === 'ready' ? 100 : null;
    default:
      return null;
  }
}
