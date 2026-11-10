import type { OpenCodeTeamLaunchReadiness } from '../opencode/readiness/OpenCodeTeamLaunchReadiness';

function getOpenCodeReadinessDiagnosticText(readiness: OpenCodeTeamLaunchReadiness): string {
  return [...readiness.diagnostics, ...readiness.missing].join('\n');
}

function isInternallyExhaustedOpenCodeWorkDiagnosticLine(line: string): boolean {
  if (!line.includes('timed out')) {
    return false;
  }

  return (
    line.includes('opencode inventory probe') ||
    line.includes('failed to query opencode models:') ||
    line.includes('failed to query opencode agents:') ||
    line.includes('opencode command') ||
    line.includes('opencode bridge command') ||
    line.includes('bridge command') ||
    line.includes('/config request failed:') ||
    (line.includes('opencode request timed out') && line.includes('/config'))
  );
}

export function isTransientOpenCodeReadinessTransportFailure(
  readiness: OpenCodeTeamLaunchReadiness
): boolean {
  if (readiness.launchAllowed) {
    return false;
  }
  if (readiness.state !== 'mcp_unavailable' && readiness.state !== 'unknown_error') {
    return false;
  }

  const diagnosticText = getOpenCodeReadinessDiagnosticText(readiness).toLowerCase();
  const hasInternallyExhaustedWork = diagnosticText
    .split('\n')
    .some(isInternallyExhaustedOpenCodeWorkDiagnosticLine);
  if (hasInternallyExhaustedWork) {
    return false;
  }

  const hasTransientTransportMarker =
    /\b(?:unable|failed) to connect\b/.test(diagnosticText) ||
    /\b(?:connection (?:was )?(?:reset|refused|closed)|connection (?:hangup|hang up)|socket (?:connection )?(?:was )?closed|socket closure|socket (?:hangup|hang up))\b/.test(
      diagnosticText
    ) ||
    diagnosticText.includes('fetch failed') ||
    diagnosticText.includes('econnreset') ||
    diagnosticText.includes('econnrefused') ||
    /\bnetwork ?error\b/.test(diagnosticText);
  if (!hasTransientTransportMarker) {
    return false;
  }

  const hasHardFailureMarker =
    /\b(?:401|403)\b/.test(diagnosticText) ||
    diagnosticText.includes('unauthorized') ||
    diagnosticText.includes('forbidden') ||
    diagnosticText.includes('missing canonical app mcp tool id') ||
    diagnosticText.includes('observed alias') ||
    diagnosticText.includes('app mcp tool missing') ||
    diagnosticText.includes('tool is absent') ||
    diagnosticText.includes('missing required field') ||
    diagnosticText.includes('runtime store') ||
    diagnosticText.includes('capability snapshot') ||
    diagnosticText.includes('contract') ||
    diagnosticText.includes('schema') ||
    diagnosticText.includes('invalid input') ||
    /\b(?:404|405)\b/.test(diagnosticText);

  return !hasHardFailureMarker;
}
