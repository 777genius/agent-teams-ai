import { createContext, useContext } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
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
      {children}
    </OpenCodeGenerationContext.Provider>
  );
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
    <span
      data-testid={`runtime-provider-compatibility-${providerId}`}
      className="text-[10px] text-[var(--color-text-muted)]"
      title={reason}
    >
      {t(incompatible
        ? 'cliStatus.quickConnect.requiresV1'
        : 'cliStatus.quickConnect.v2Unverified')}
    </span>
  );
}
