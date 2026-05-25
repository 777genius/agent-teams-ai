import * as os from 'os';

import { redactBridgeDiagnosticText } from './OpenCodeBridgeCommandClient';

import type { OpenCodeBridgeFailure } from './OpenCodeBridgeCommandContract';
import type { TeamProvisioningSupportDiagnostic } from '@shared/types/team';

const NO_OUTPUT_TITLE = 'OpenCode runtime check returned no output';
const NO_OUTPUT_SUMMARY = 'OpenCode readiness bridge exited without returning diagnostic JSON.';

export function isOpenCodeBridgeNoOutputDiagnostic(value: string | null | undefined): boolean {
  const lower = value?.trim().toLowerCase() ?? '';
  return (
    lower.includes('opencode runtime check returned no output') ||
    lower.includes('bridge stdout was empty') ||
    lower.includes('opencode_bridge_contract_violation') ||
    (lower.includes('opencode readiness bridge failed') && lower.includes('contract_violation'))
  );
}

export function buildOpenCodeBridgeSupportDiagnostic(input: {
  result: OpenCodeBridgeFailure;
  projectPath: string;
  selectedModel: string | null;
  appVersion?: string | null;
}): TeamProvisioningSupportDiagnostic | null {
  const event =
    input.result.diagnostics.find((diagnostic) =>
      isOpenCodeBridgeNoOutputDiagnostic(`${diagnostic.type}: ${diagnostic.message}`)
    ) ?? input.result.diagnostics[0];
  const visibleError = `OpenCode readiness bridge failed: ${input.result.error.kind}: ${input.result.error.message}`;
  const eventText = event ? `${event.type}: ${event.message}` : '';
  if (
    !isOpenCodeBridgeNoOutputDiagnostic(visibleError) &&
    !isOpenCodeBridgeNoOutputDiagnostic(eventText)
  ) {
    return null;
  }

  const details = {
    ...(event?.data ?? {}),
    ...(input.result.error.details ?? {}),
  };
  const createdAt = event?.createdAt ?? input.result.completedAt;
  const copyText = buildOpenCodeBridgeSupportCopyText({
    createdAt,
    severity: event?.severity ?? (input.result.error.retryable ? 'warning' : 'error'),
    visibleError,
    details,
    result: input.result,
    projectPath: input.projectPath,
    selectedModel: input.selectedModel,
    appVersion: input.appVersion ?? null,
  });

  return {
    id: event?.id ?? `opencode-bridge-support-${input.result.requestId}`,
    providerId: 'opencode',
    kind: 'opencode_bridge_no_output',
    severity: event?.severity ?? (input.result.error.retryable ? 'warning' : 'error'),
    title: NO_OUTPUT_TITLE,
    summary: NO_OUTPUT_SUMMARY,
    copyText,
    createdAt,
  };
}

function buildOpenCodeBridgeSupportCopyText(input: {
  createdAt: string;
  severity: 'info' | 'warning' | 'error';
  visibleError: string;
  details: Record<string, unknown>;
  result: OpenCodeBridgeFailure;
  projectPath: string;
  selectedModel: string | null;
  appVersion: string | null;
}): string {
  const command = formatDiagnosticValue(input.details.command, input.result.command);
  const requestId = formatDiagnosticValue(input.details.requestId, input.result.requestId);
  const stderrPreview = formatPreview(input.details.stderrPreview);
  const likelyCause = formatLikelyCause(input.details);

  const lines = [
    'Agent Teams OpenCode diagnostics',
    `Time: ${input.createdAt}`,
    'Provider: opencode',
    `Severity: ${input.severity}`,
    `Title: ${NO_OUTPUT_TITLE}`,
    `Summary: ${NO_OUTPUT_SUMMARY}`,
    '',
    'Visible error:',
    redactBridgeDiagnosticText(input.visibleError),
    '',
    'Bridge command:',
    `command: ${command}`,
    `requestId: ${requestId}`,
    `binaryPath: ${formatDiagnosticPathValue(input.details.binaryPath)}`,
    `cwd: ${formatDiagnosticPathValue(input.details.cwd)}`,
    `attempts: ${formatDiagnosticValue(input.details.attempts)}`,
    `exitCode: ${formatDiagnosticValue(input.details.exitCode)}`,
    `timedOut: ${formatDiagnosticValue(input.details.timedOut)}`,
    `stdoutBytes: ${formatDiagnosticValue(input.details.stdoutBytes)}`,
    `stderrBytes: ${formatDiagnosticValue(input.details.stderrBytes)}`,
    `outputSource: ${formatDiagnosticValue(input.details.outputSource)}`,
    `outputFileBytes: ${formatDiagnosticValue(input.details.outputFileBytes)}`,
    `outputReadError: ${formatDiagnosticValue(input.details.outputReadError)}`,
    '',
    'Environment:',
    `platform: ${process.platform}`,
    `arch: ${process.arch}`,
    `appVersion: ${formatDiagnosticValue(input.appVersion)}`,
    `projectPath: ${redactDiagnosticPath(input.projectPath)}`,
    `selectedModel: ${formatDiagnosticValue(input.selectedModel)}`,
  ];

  if (likelyCause) {
    lines.push('', 'Likely cause:', likelyCause);
  }

  lines.push('', 'stderrPreview:', stderrPreview);

  return lines.join('\n');
}

function formatLikelyCause(details: Record<string, unknown>): string | null {
  if (details.exitCode !== 9009) {
    return null;
  }
  return 'Windows could not start the bridge launcher. Check that the runtime launcher and its dependencies, such as Bun for cli-dev.cmd, are available in PATH.';
}

function formatDiagnosticValue(value: unknown, fallback: unknown = undefined): string {
  const resolved = value ?? fallback;
  if (resolved === null || resolved === undefined || resolved === '') {
    return '(none)';
  }
  if (typeof resolved === 'string') {
    return redactBridgeDiagnosticText(resolved);
  }
  if (typeof resolved === 'number' || typeof resolved === 'boolean') {
    return String(resolved);
  }
  return redactBridgeDiagnosticText(JSON.stringify(resolved));
}

function formatDiagnosticPathValue(value: unknown): string {
  if (typeof value !== 'string') {
    return formatDiagnosticValue(value);
  }
  return redactDiagnosticPath(value);
}

function formatPreview(value: unknown): string {
  const formatted = formatDiagnosticValue(value);
  return formatted === '(none)' ? '(empty)' : formatted;
}

function redactDiagnosticPath(value: string): string {
  const home = os.homedir();
  const trimmed = value.trim();
  if (!trimmed) {
    return '(none)';
  }
  if (home && trimmed.startsWith(home)) {
    return `~${trimmed.slice(home.length)}`;
  }
  return redactBridgeDiagnosticText(trimmed);
}
