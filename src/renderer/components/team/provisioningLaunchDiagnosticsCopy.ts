import type { TeamLaunchFailureDiagnosticsBundle } from '@shared/types';

export function formatOptionalValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '(none)';
  return String(value);
}

export function formatLaunchFailureArtifactCopy(
  bundle: TeamLaunchFailureDiagnosticsBundle | null | undefined,
  error?: string | null
): string {
  if (error) return `Failed to read launch failure artifact bundle: ${error}`;
  if (!bundle) return '(none)';
  if (bundle.source === 'captured-host') {
    return [
      'source: captured-host (read-only launch/runtime observations)',
      `teamName: ${bundle.teamName}`,
      `runId: ${formatOptionalValue(bundle.runId)}`,
      `status: ${bundle.observations?.some((item) => item.issue) ? 'partial' : 'observed'}`,
      ...(bundle.observations ?? []).flatMap((item) => [
        '',
        `--- ${item.label}`,
        item.issue ? `issue: ${item.issue}` : 'issue: (none)',
        'content:',
        item.content?.trim() || '(unavailable)',
      ]),
    ].join('\n');
  }
  const parts = [
    `teamName: ${bundle.teamName}`,
    `runId: ${formatOptionalValue(bundle.runId)}`,
    `latestPath: ${bundle.latestPath}`,
    `artifactDirectory: ${formatOptionalValue(bundle.artifactDirectory)}`,
    `manifestPath: ${formatOptionalValue(bundle.manifestPath)}`,
    '',
    'classification:',
    bundle.classification ? JSON.stringify(bundle.classification, null, 2) : '(none)',
    '',
    'bootstrapTransportBreadcrumb:',
    bundle.bootstrapTransportBreadcrumb
      ? JSON.stringify(bundle.bootstrapTransportBreadcrumb, null, 2)
      : '(none)',
    '',
    'files:',
  ];
  for (const file of bundle.files) {
    parts.push(
      '',
      `--- ${file.label}`,
      `path: ${file.path}`,
      file.issue ? `issue: ${file.issue}` : 'issue: (none)',
      'content:',
      file.content?.trim() || '(empty)'
    );
  }
  return parts.join('\n');
}
