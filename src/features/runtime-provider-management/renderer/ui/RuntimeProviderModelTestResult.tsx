import { useAppTranslation } from '@features/localization/renderer';

import type { RuntimeProviderModelTestResultDto } from '@features/runtime-provider-management/contracts';
import type { JSX } from 'react';

interface RuntimeProviderModelTestMessage {
  readonly summary: string;
  readonly details: unknown | null;
}

interface RuntimeProviderModelTestResultProps {
  readonly result: RuntimeProviderModelTestResultDto | undefined;
  readonly formatMessage: (message: string) => RuntimeProviderModelTestMessage;
}

export const RuntimeProviderModelTestResult = ({
  result,
  formatMessage,
}: RuntimeProviderModelTestResultProps): JSX.Element | null => {
  const { t } = useAppTranslation('settings');
  if (!result) {
    return null;
  }

  const formattedMessage = formatMessage(result.message);
  const structuredDiagnostics = {
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    ...(result.effectiveBaseUrl ? { effectiveBaseUrl: result.effectiveBaseUrl } : {}),
    ...(result.providerSource ? { providerSource: result.providerSource } : {}),
  };
  const hasStructuredDiagnostics = Object.keys(structuredDiagnostics).length > 0;
  const diagnostics = result.diagnostics.filter((entry) => entry.trim());

  return (
    <div
      className="mt-2 space-y-2 text-xs"
      style={{ color: result.ok ? '#86efac' : '#fecaca' }}
      data-testid={`runtime-provider-model-result-${result.modelId}`}
    >
      {formattedMessage.summary ? (
        <p className="whitespace-pre-wrap break-words">{formattedMessage.summary}</p>
      ) : null}
      {formattedMessage.details !== null ? (
        <pre className="max-h-64 overflow-auto rounded-md border border-white/10 bg-black/20 p-3 font-mono text-[11px] leading-5 text-inherit">
          {JSON.stringify(formattedMessage.details, null, 2)}
        </pre>
      ) : null}
      {hasStructuredDiagnostics ? (
        <pre
          className="max-h-40 overflow-auto rounded-md border border-white/10 bg-black/20 p-2 font-mono text-[11px] leading-4 text-[var(--color-text-muted)]"
          data-testid={`runtime-provider-model-metadata-${result.modelId}`}
        >
          {JSON.stringify(structuredDiagnostics, null, 2)}
        </pre>
      ) : null}
      {diagnostics.length > 0 ? (
        <details className="rounded-md border border-white/10 bg-black/10 px-2 py-1.5 text-[11px] leading-4 text-[var(--color-text-muted)]">
          <summary className="cursor-pointer select-none">
            {t('runtimeProvider.diagnostics.hints')}
          </summary>
          <ul className="mt-1 space-y-1 break-words pl-4">
            {diagnostics.map((entry, index) => (
              <li key={`${index}:${entry}`}>{entry}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
};
