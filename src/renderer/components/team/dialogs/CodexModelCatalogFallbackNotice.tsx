import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { isCodexModelCatalogFallbackActive } from '@renderer/utils/codexModelCatalogFallback';
import { AlertTriangle } from 'lucide-react';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CliProviderModelCatalog } from '@shared/types';

export interface CodexModelCatalogFallbackNoticeProps {
  catalog: CliProviderModelCatalog | null | undefined;
  runtimeStatus: CodexRuntimeStatus | null | undefined;
  onUpdate: () => void;
}

export const CodexModelCatalogFallbackNotice = ({
  catalog,
  runtimeStatus,
  onUpdate,
}: CodexModelCatalogFallbackNoticeProps): React.JSX.Element | null => {
  const { t: teamT } = useAppTranslation('team');
  const { t: dashboardT } = useAppTranslation('dashboard');

  if (!isCodexModelCatalogFallbackActive(catalog)) {
    return null;
  }

  const latestVersion =
    runtimeStatus?.installed && runtimeStatus.updateAvailable ? runtimeStatus.latestVersion : null;

  return (
    <div
      data-testid="codex-model-catalog-fallback-notice"
      className="mb-3 flex items-start gap-3 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-amber-100"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-200" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs font-medium">{teamT('modelSelector.codexCatalogFallbackTitle')}</p>
        <p className="text-[11px] leading-relaxed opacity-85">
          {teamT('modelSelector.codexCatalogFallbackMessage')}
        </p>
      </div>
      {latestVersion ? (
        <Button variant="outline" size="sm" onClick={onUpdate} className="shrink-0">
          {dashboardT('cliStatus.actions.updateTo', {
            version: latestVersion,
          })}
        </Button>
      ) : null}
    </div>
  );
};
