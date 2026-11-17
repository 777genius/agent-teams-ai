import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';

import { NativeNextPromptProviderCard } from './ui/NativeNextPromptProviderCard';

import type { JSX } from 'react';

/**
 * One provider's next-message suggestions switch on its Provider Settings page. On by default; a change is
 * captured by the next Host start, never by a session that is already running.
 */
export function NativeNextPromptProviderSetting({
  providerId,
}: {
  readonly providerId: 'anthropic' | 'codex';
}): JSX.Element {
  const { t } = useAppTranslation('settings');
  const updateConfig = useStore((state) => state.updateConfig);
  // Missing means the shipped default, which is on.
  const enabled =
    useStore(
      (state) =>
        state.appConfig?.providerConnections?.[providerId]?.nativeNextPromptSuggestionsEnabled
    ) !== false;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (value: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await updateConfig('providerConnections', {
        [providerId]: { nativeNextPromptSuggestionsEnabled: value },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('providerRuntime.nativeNextPrompt.error')
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <NativeNextPromptProviderCard
      providerId={providerId}
      title={t('providerRuntime.nativeNextPrompt.title')}
      description={t('providerRuntime.nativeNextPrompt.description')}
      enabled={enabled}
      saving={saving}
      error={error}
      onChange={(value) => void change(value)}
    />
  );
}
