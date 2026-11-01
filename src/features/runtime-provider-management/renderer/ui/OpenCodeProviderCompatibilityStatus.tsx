import { createContext, useContext } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';

import { getOpenCodeGeneration, resolveOpenCodeProviderCompatibility } from '../../core/domain';

import type { OpenCodeGeneration } from '../../core/domain';
import type { JSX, ReactNode } from 'react';

const OpenCodeGenerationContext = createContext<OpenCodeGeneration | null>(null);

/** The chosen generation is the selected native runtime, never guessed from a missing status. */
export function OpenCodeProviderCompatibilityScope({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const runtimeStatus = useStore((state) => state.openCodeRuntimeStatus);
  const generation =
    runtimeStatus?.installed && runtimeStatus.version
      ? getOpenCodeGeneration(runtimeStatus.version)
      : null;
  return (
    <OpenCodeGenerationContext.Provider value={generation}>
      <TooltipProvider>{children}</TooltipProvider>
    </OpenCodeGenerationContext.Provider>
  );
}

/** Only the unsupported managed routes block setup actions. Users can still view or forget them. */
export function useOpenCodeProviderConnectionBlocked(providerId: string): boolean {
  const generation = useContext(OpenCodeGenerationContext);
  return generation === 'v2' &&
    !resolveOpenCodeProviderCompatibility(providerId, generation).canConnect;
}

/** Neither a saved credential nor a provider listing proves model execution. */
export function OpenCodeProviderCompatibilityStatus({
  providerId,
}: {
  readonly providerId: string;
}): JSX.Element | null {
  const generation = useContext(OpenCodeGenerationContext);
  const { t } = useAppTranslation('dashboard');
  if (generation !== 'v2') return null;
  const compatibility = resolveOpenCodeProviderCompatibility(providerId, generation);
  const incompatible = compatibility.state === 'incompatible';
  const reason =
    incompatible && compatibility.reason === 'cli-plugin'
      ? t('cliStatus.quickConnect.v2CliPluginLimitation')
      : incompatible
        ? t('cliStatus.quickConnect.v2OAuthLimitation')
        : t('cliStatus.quickConnect.v2UnverifiedDetail');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={`runtime-provider-compatibility-${providerId}`}
          aria-label={reason}
          onClick={(event) => event.stopPropagation()}
          className="rounded text-[10px] text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {t(incompatible
            ? 'cliStatus.quickConnect.requiresV1'
            : 'cliStatus.quickConnect.v2Unverified')}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-72 text-pretty text-xs">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
