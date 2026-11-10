import { useAppTranslation } from '@features/localization/renderer';
import { Info } from 'lucide-react';

import { LOCAL_TEAMMATE_REQUIREMENTS } from '../runtimeLocalProviderSetupCopy';

import type { RuntimeLocalProviderPresetIdDto } from '../../contracts';
import type { JSX } from 'react';

export interface LocalTeammateModelRequirementsProps {
  readonly title: string;
  readonly size: string;
  readonly tools: string;
  readonly context: string;
  readonly tiny: string;
}

/** Always-visible teammate size/context/tool requirements for local model settings. */
export const LocalTeammateModelRequirements = ({
  title,
  size,
  tools,
  context,
  tiny,
}: LocalTeammateModelRequirementsProps): JSX.Element => {
  return (
    <div
      data-testid="local-teammate-model-requirements"
      className="rounded-md border border-cyan-600/20 bg-cyan-500/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-cyan-900 dark:border-cyan-300/20 dark:bg-cyan-300/[0.06] dark:text-cyan-50"
    >
      <div className="flex items-start gap-2">
        <Info
          className="mt-0.5 size-3.5 shrink-0 text-cyan-700 dark:text-cyan-200"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium text-cyan-900 dark:text-cyan-50">{title}</p>
          <ul className="list-disc space-y-1 pl-4 text-cyan-800/80 dark:text-cyan-100/80">
            <li>{size}</li>
            <li>{tools}</li>
            <li>{context}</li>
            <li>{tiny}</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export const SetupLocalTeammateModelRequirements = ({
  presetId,
}: {
  readonly presetId: RuntimeLocalProviderPresetIdDto | string | null;
}): JSX.Element => (
  <LocalTeammateModelRequirements
    title={LOCAL_TEAMMATE_REQUIREMENTS.title}
    size={LOCAL_TEAMMATE_REQUIREMENTS.size}
    tools={LOCAL_TEAMMATE_REQUIREMENTS.tools}
    context={
      presetId === 'ollama'
        ? LOCAL_TEAMMATE_REQUIREMENTS.ollamaContext
        : LOCAL_TEAMMATE_REQUIREMENTS.context
    }
    tiny={LOCAL_TEAMMATE_REQUIREMENTS.tiny}
  />
);

export const SelectorLocalTeammateModelRequirements = (): JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="mb-3">
      <LocalTeammateModelRequirements
        title={t('modelSelector.localModels.teammateRequirementsTitle')}
        size={t('modelSelector.localModels.teammateRequirementsSize')}
        tools={t('modelSelector.localModels.teammateRequirementsTools')}
        context={t('modelSelector.localModels.teammateRequirementsContext')}
        tiny={t('modelSelector.localModels.teammateRequirementsTiny')}
      />
    </div>
  );
};
