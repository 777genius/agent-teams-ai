import { useEffect, useState } from 'react';

import { Server } from 'lucide-react';

import type { RuntimeLocalProviderPresetIdDto } from '../../contracts';
import type { JSX } from 'react';

const OFFICIAL_LOCAL_PROVIDER_LOGOS: Partial<Record<RuntimeLocalProviderPresetIdDto, string>> = {
  // Provider-owned artwork. Keep these marks unmodified and use the generic
  // fallback if a remote asset is unavailable.
  ollama: 'https://raw.githubusercontent.com/ollama/ollama/main/docs/favicon-dark.svg',
  'lm-studio': 'https://lmstudio.ai/assets/marketing/brand/download/logos/lm-studio-icon-color.svg',
  'atomic-chat':
    'https://raw.githubusercontent.com/AtomicBot-ai/Atomic-Chat/main/src-tauri/icons/icon.png',
  'llama.cpp':
    'https://raw.githubusercontent.com/ggml-org/llama.cpp/master/media/llama1-icon-transparent.svg',
};

interface LocalProviderBrandIconProps {
  readonly presetId: RuntimeLocalProviderPresetIdDto;
  readonly displayName: string;
  readonly size?: 'small' | 'default' | 'large';
}

export const LocalProviderBrandIcon = ({
  presetId,
  displayName,
  size = 'default',
}: LocalProviderBrandIconProps): JSX.Element => {
  const src = OFFICIAL_LOCAL_PROVIDER_LOGOS[presetId] ?? null;
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  const sizeClass =
    size === 'large'
      ? 'size-10 rounded-xl'
      : size === 'small'
        ? 'size-5 rounded'
        : 'size-7 rounded-lg';
  const imageClass = size === 'large' ? 'size-8' : size === 'small' ? 'size-4' : 'size-5';

  return (
    <span
      data-testid={`local-provider-logo-${presetId}`}
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden border border-white/10 bg-white/95 ${sizeClass}`}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className={`${imageClass} object-contain`}
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : presetId === 'custom' ? (
        <Server className={`${imageClass} text-slate-600`} />
      ) : (
        <span className="text-[9px] font-bold leading-none text-slate-700">
          {displayName.slice(0, 2).toUpperCase()}
        </span>
      )}
    </span>
  );
};
