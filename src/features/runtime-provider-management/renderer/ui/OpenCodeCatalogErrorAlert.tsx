import { useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import { cleanRuntimeDiagnosticText } from '../../contracts';

import {
  formatRuntimeProviderDiagnosticsCopyText,
  RuntimeProviderErrorAlert,
} from './RuntimeProviderErrorAlert';

import type { OpenCodeCatalogFailure } from '../hooks/catalogFailure';

const MAX_REPORT = 16384;
const MAX_FAILURES = 16;
const REPORT_TITLE = 'OpenCode catalog diagnostics';

export function formatOpenCodeCatalogReport(failures: readonly OpenCodeCatalogFailure[]): string {
  const current = failures.slice(0, MAX_FAILURES);
  // Reserve the index first: clipping verbose previews must never erase the four source IDs.
  const index = current
    .map((failure, i) =>
      [
        `${i + 1}. ${failure.operation} source=${cleanRuntimeDiagnosticText(failure.sourceProviderId, 256) ?? 'null'}`,
        `origin=${failure.origin} reportId=${cleanRuntimeDiagnosticText(failure.diagnostics?.reportId, 256) ?? 'unavailable'}`,
      ].join(' ')
    )
    .join('\n');
  const omitted = failures.length - current.length;
  const heading = `${REPORT_TITLE}\n${index}\n${omitted ? `[truncated: ${omitted} failures omitted; copy individually]\n` : ''}`;
  const budget = Math.floor((MAX_REPORT - heading.length - 100) / Math.max(current.length, 1));
  return (
    heading +
    current
      .map((failure, i) => {
        const context =
          failure.origin === 'stale'
            ? 'Data state: stale; no process failure reported.\n'
            : !failure.diagnostics?.reportId
              ? 'Main log correlation: unavailable (no desktop report ID received).\n'
              : '';
        const detail = formatRuntimeProviderDiagnosticsCopyText(
          failure.message,
          failure.diagnostics,
          REPORT_TITLE
        );
        return `\n${i + 1}.\n${cleanRuntimeDiagnosticText(context + detail, budget - 16)}`;
      })
      .join('\n')
  );
}

export const OpenCodeCatalogErrorAlert = ({
  failures,
}: {
  failures: readonly OpenCodeCatalogFailure[];
}) => {
  const { t } = useAppTranslation('common');
  const { t: settingsT } = useAppTranslation('settings');
  const [pagination, setPagination] = useState({ failures, page: 0 });
  // Reset during render so a retry never commits details from the previous page.
  if (pagination.failures !== failures) {
    setPagination({ failures, page: 0 });
  }
  const pageCount = Math.ceil(failures.length / MAX_FAILURES);
  const page =
    pagination.failures === failures ? Math.min(pagination.page, Math.max(0, pageCount - 1)) : 0;
  const report = useMemo(() => formatOpenCodeCatalogReport(failures), [failures]);
  if (!failures.length) return null;
  const start = page * MAX_FAILURES;
  return (
    <div className="w-full min-w-0">
      <RuntimeProviderErrorAlert
        compact
        copyAll={!report.includes('[truncated')}
        testId="opencode-catalog-error"
        message={t('providerModelBadges.checkFailed')}
        reportText={report}
      />
      {report.includes('[truncated')
        ? failures
            .slice(start, start + MAX_FAILURES)
            .map((failure, index) => (
              <RuntimeProviderErrorAlert
                key={start + index}
                compact
                testId={`opencode-catalog-error-${start + index}`}
                message={`${failure.sourceProviderId ?? failure.operation}: ${failure.message}`}
                reportText={formatOpenCodeCatalogReport([failure])}
              />
            ))
        : null}
      {pageCount > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="opencode-catalog-previous-page"
            disabled={page === 0}
            onClick={() => setPagination({ failures, page: page - 1 })}
          >
            {settingsT('runtimeProvider.diagnostics.previousPage')}
          </Button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="opencode-catalog-next-page"
            disabled={page === pageCount - 1}
            onClick={() => setPagination({ failures, page: page + 1 })}
          >
            {settingsT('runtimeProvider.diagnostics.nextPage')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
