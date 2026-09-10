import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic } from '@shared/utils/openCodeWindowsAccessDenied';
import { AlertTriangle, Check, ClipboardList } from 'lucide-react';

import { cleanRuntimeDiagnosticText, runtimeErrorDetailRows } from '../../contracts';

import type { RuntimeProviderManagementErrorDiagnosticsDto } from '../../contracts';

interface RuntimeProviderErrorAlertProps {
  readonly message: string;
  readonly reportText?: string;
  readonly diagnostics?: RuntimeProviderManagementErrorDiagnosticsDto | null;
  readonly testId: string;
  readonly compact?: boolean;
}

export function formatRuntimeProviderDiagnosticsCopyText(
  message: string,
  diagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null | undefined
): string {
  const lines = [
    'OpenCode catalog diagnostics',
    '',
    'Message:',
    cleanRuntimeDiagnosticText(message) ?? '',
  ];
  if (!diagnostics) {
    return lines.join('\n');
  }
  const hints = diagnostics.hints ?? [];

  const fields: [string, string | number | null][] = [
    ['Error code', diagnostics.errorCode ?? null],
    ['Summary', diagnostics.summary],
    ['Likely cause', diagnostics.likelyCause],
    ['Resolved runtime binary', diagnostics.binaryPath],
    ['Command', diagnostics.command],
    ['Project path', diagnostics.projectPath],
    ['Exit code', diagnostics.exitCode],
  ];

  fields.push(...runtimeErrorDetailRows(diagnostics));
  lines.push('', 'Structured diagnostics:');
  for (const [label, value] of fields) {
    if (value !== null && value !== '') {
      lines.push(`${label}: ${String(value)}`);
    }
  }

  if (hints.length > 0) {
    lines.push('', 'Hints:', ...hints.map((hint) => `- ${hint}`));
  }
  if (diagnostics.stderrPreview) {
    lines.push('', 'stderr preview:', diagnostics.stderrPreview);
  }
  if (diagnostics.stdoutPreview) {
    lines.push('', 'stdout preview:', diagnostics.stdoutPreview);
  }

  return cleanRuntimeDiagnosticText(lines.join('\n'), 16384) ?? '';
}

function getRuntimeProviderDiagnosticRows(
  diagnostics: RuntimeProviderManagementErrorDiagnosticsDto
): [string, string][] {
  const rows: [string, string | number | null][] = [
    ['Code', diagnostics.errorCode ?? null],
    ['Binary', diagnostics.binaryPath],
    ['Command', diagnostics.command],
    ['Project', diagnostics.projectPath],
    ['Exit', diagnostics.exitCode],
  ];
  rows.push(...runtimeErrorDetailRows(diagnostics));
  return rows
    .filter(([, value]) => value !== null && value !== '')
    .map(([label, value]) => [label, String(value)]);
}

function isOpenCodeWindowsNodeModulesSymlinkPermissionError(
  message: string,
  diagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null | undefined
): boolean {
  const value = [
    message,
    diagnostics?.stderrPreview ?? '',
    diagnostics?.stdoutPreview ?? '',
    diagnostics?.likelyCause ?? '',
    ...(diagnostics?.hints ?? []),
  ].join('\n');
  return isOpenCodeWindowsNodeModulesSymlinkPermissionDiagnostic(value);
}

async function writeRuntimeProviderDiagnosticsToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to the selection API below.
    }
  }

  return copyRuntimeProviderDiagnosticsWithSelection(text);
}

function copyRuntimeProviderDiagnosticsWithSelection(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export const RuntimeProviderErrorAlert = ({
  message,
  reportText,
  diagnostics = null,
  testId,
  compact = false,
}: RuntimeProviderErrorAlertProps): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { t: commonT } = useAppTranslation('common');
  const [headline = message, ...detailLines] = message.trim().split(/\r?\n/);
  const fallbackDetails = reportText ?? detailLines.join('\n').trim();
  const hints = diagnostics?.hints ?? [];
  const showWindowsSymlinkPermissionHint = isOpenCodeWindowsNodeModulesSymlinkPermissionError(
    message,
    diagnostics
  );
  const copyText = useMemo(
    () => reportText === undefined ? formatRuntimeProviderDiagnosticsCopyText(message, diagnostics) : cleanRuntimeDiagnosticText(reportText, 16384) ?? '',
    [diagnostics, message, reportText]
  );
  const copyGeneration = useRef(0);
  const diagnosticRows = diagnostics ? getRuntimeProviderDiagnosticRows(diagnostics) : [];
  const copyDiagnostics = useCallback(async (): Promise<void> => {
    const generation = copyGeneration.current;
    const success = await writeRuntimeProviderDiagnosticsToClipboard(copyText);
    if (copyGeneration.current !== generation) return;
    setCopied(success);
    setCopyFailed(!success);
  }, [copyText]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeout = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
    return () => {
      copyGeneration.current += 1;
    };
  }, [copyText]);

  return (
    <div
      data-testid={testId}
      role="alert"
      className="flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: 'rgba(248, 113, 113, 0.25)',
        backgroundColor: 'rgba(248, 113, 113, 0.06)',
        color: '#fca5a5',
      }}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 whitespace-pre-wrap break-words font-medium leading-5">
            {headline || message}
            {showWindowsSymlinkPermissionHint ? (
              <span className="ml-2 inline-flex rounded border border-red-200/30 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-semibold leading-4 text-red-50">
                {t('runtimeProvider.diagnostics.windowsSymlinkAdminHint')}
              </span>
            ) : null}
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-6 shrink-0 px-2 text-[11px]',
                    !copied && 'member-launch-diagnostics-pulse'
                  )}
                  aria-label={
                    copied
                      ? t('runtimeProvider.diagnostics.copied')
                      : t('runtimeProvider.diagnostics.copy')
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyDiagnostics();
                  }}
                >
                  {copied ? (
                    <Check className="mr-1 size-3" />
                  ) : (
                    <ClipboardList className="mr-1 size-3" />
                  )}
                  {copied
                    ? t('runtimeProvider.diagnostics.copiedShort')
                    : t('runtimeProvider.diagnostics.copy')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('runtimeProvider.diagnostics.copy')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {copyFailed ? (
          <div role="status">
            {commonT('codexLogin.copyFailed')}
            <pre tabIndex={0} className="max-h-48 select-text overflow-auto whitespace-pre-wrap">
              {copyText}
            </pre>
          </div>
        ) : null}
        {compact && diagnostics?.stage ? (
          <div className="mt-1 font-mono">{diagnostics.stage}</div>
        ) : null}
        <Collapsible open={!compact || expanded} onOpenChange={setExpanded}>
          {compact ? (
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm">
                {commonT(expanded ? 'tmuxInstaller.details.hide' : 'tmuxInstaller.details.show')}
              </Button>
            </CollapsibleTrigger>
          ) : null}
          <CollapsibleContent>
            {diagnostics ? (
              <div className="mt-2 space-y-2">
                {diagnostics.likelyCause ? (
                  <div className="whitespace-pre-wrap break-words leading-5 text-red-100">
                    <span className="font-medium text-red-100">
                      {t('runtimeProvider.diagnostics.likelyCause')}{' '}
                    </span>
                    {diagnostics.likelyCause}
                  </div>
                ) : null}
                {diagnosticRows.length > 0 ? (
                  <dl className="grid gap-1 rounded border px-2 py-1.5 text-[11px] leading-4 sm:grid-cols-[92px_minmax(0,1fr)]">
                    {diagnosticRows.map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-red-200/75">{label}</dt>
                        <dd className="min-w-0 break-words font-mono text-red-100">{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {hints.length > 0 ? (
                  <div>
                    <div className="mb-1 font-medium text-red-100">
                      {t('runtimeProvider.diagnostics.hints')}
                    </div>
                    <ul className="space-y-1 pl-4">
                      {hints.map((hint, index) => (
                        <li
                          key={`${hint}-${index}`}
                          className="list-disc whitespace-pre-wrap break-words"
                        >
                          {hint}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {diagnostics.stderrPreview ? (
                  <pre
                    data-testid={`${testId}-stderr-preview`}
                    className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-4"
                    style={{
                      borderColor: 'rgba(248, 113, 113, 0.2)',
                      backgroundColor: 'rgba(15, 23, 42, 0.38)',
                      color: '#fecaca',
                    }}
                  >
                    {`stderr preview:\n${diagnostics.stderrPreview}`}
                  </pre>
                ) : null}
                {diagnostics.stdoutPreview ? (
                  <pre
                    data-testid={`${testId}-stdout-preview`}
                    className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-4"
                    style={{
                      borderColor: 'rgba(248, 113, 113, 0.2)',
                      backgroundColor: 'rgba(15, 23, 42, 0.38)',
                      color: '#fecaca',
                    }}
                  >
                    {`stdout preview:\n${diagnostics.stdoutPreview}`}
                  </pre>
                ) : null}
              </div>
            ) : fallbackDetails ? (
              <pre
                className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-4"
                style={{
                  borderColor: 'rgba(248, 113, 113, 0.2)',
                  backgroundColor: 'rgba(15, 23, 42, 0.38)',
                  color: '#fecaca',
                }}
              >
                {fallbackDetails}
              </pre>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
};
