import { useId } from 'react';

import type { CliProviderId } from '@shared/types';

type ProviderBrandLogoId = CliProviderId | 'opencode';

type BrandLogoProps = Readonly<{
  className?: string;
}>;

interface ProviderBrandLogoProps {
  readonly providerId: ProviderBrandLogoId;
  readonly className?: string;
}

const AnthropicBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g fill="#D97757">
        {Array.from({ length: 10 }).map((_, index) => (
          <rect
            key={index}
            x="10.75"
            y="1.8"
            width="2.5"
            height="7.7"
            rx="1.2"
            transform={`rotate(${index * 36} 12 12)`}
          />
        ))}
        <circle cx="12" cy="12" r="3.1" />
      </g>
    </svg>
  );
};

const CodexBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();

  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6.5" fill="#F8FAFC" />
      <path
        d="M17.6 10.2a4.95 4.95 0 0 0-8.58-2.43 3.7 3.7 0 0 0-4.25 5.73A3.46 3.46 0 0 0 6.34 20h10.12a3.65 3.65 0 0 0 1.14-7.14Z"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M9.05 9.55 11.4 12l-2.35 2.45"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.1 14.45h3.05"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="12"
          y1="6.4"
          x2="12"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#A5B4FC" />
          <stop offset="0.55" stopColor="#6F8CFF" />
          <stop offset="1" stopColor="#3B46FF" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const GeminiBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();

  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 2.25c.62 3.9 1.6 6.57 3.18 8.15 1.58 1.58 4.25 2.56 8.15 3.18-3.9.62-6.57 1.6-8.15 3.18-1.58 1.58-2.56 4.25-3.18 8.15-.62-3.9-1.6-6.57-3.18-8.15-1.58-1.58-4.25-2.56-8.15-3.18 3.9-.62 6.57-1.6 8.15-3.18C10.4 8.82 11.38 6.15 12 2.25Z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="4"
          y1="4"
          x2="20"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#9F7AEA" />
          <stop offset="1" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const OpenCodeBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const backgroundId = useId();
  const frameId = useId();
  const frameStrokeId = useId();
  const coreId = useId();
  const coreStrokeId = useId();

  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient
          id={backgroundId}
          x1="4"
          y1="3"
          x2="20"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#303030" />
          <stop offset="1" stopColor="#161616" />
        </linearGradient>
        <linearGradient
          id={frameId}
          x1="7"
          y1="4.5"
          x2="17"
          y2="19.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#f4f4f4" />
          <stop offset="0.35" stopColor="#d9d9d9" />
          <stop offset="0.68" stopColor="#a8a8a8" />
          <stop offset="1" stopColor="#ececec" />
        </linearGradient>
        <linearGradient
          id={frameStrokeId}
          x1="7"
          y1="4.5"
          x2="17"
          y2="19.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#5a5a5a" stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id={coreId} x1="12" y1="7" x2="12" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#121212" />
          <stop offset="0.42" stopColor="#3e3b33" />
          <stop offset="1" stopColor="#16140f" />
        </linearGradient>
        <linearGradient
          id={coreStrokeId}
          x1="9"
          y1="7"
          x2="15"
          y2="17"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#f2f2f2" stopOpacity="0.95" />
          <stop offset="1" stopColor="#6e6e6e" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.2" fill={`url(#${backgroundId})`} />
      <path
        d="M7 4.25h10c.3 0 .55.25.55.55v14.4c0 .3-.25.55-.55.55H7c-.3 0-.55-.25-.55-.55V4.8c0-.3.25-.55.55-.55Z"
        fill={`url(#${frameId})`}
        stroke={`url(#${frameStrokeId})`}
        strokeWidth="0.55"
      />
      <path
        d="M8.95 7.25h6.1c.22 0 .4.18.4.4v8.7c0 .22-.18.4-.4.4h-6.1a.4.4 0 0 1-.4-.4v-8.7c0-.22.18-.4.4-.4Z"
        fill={`url(#${coreId})`}
        stroke={`url(#${coreStrokeId})`}
        strokeWidth="0.45"
      />
      <path
        d="M9.25 7.6h5.5"
        stroke="#ffffff"
        strokeOpacity="0.18"
        strokeWidth="0.45"
        strokeLinecap="round"
      />
    </svg>
  );
};

export const ProviderBrandLogo = ({
  providerId,
  className,
}: ProviderBrandLogoProps): React.JSX.Element => {
  switch (providerId) {
    case 'anthropic':
      return <AnthropicBrandLogo className={className} />;
    case 'codex':
      return <CodexBrandLogo className={className} />;
    case 'gemini':
      return <GeminiBrandLogo className={className} />;
    case 'opencode':
      return <OpenCodeBrandLogo className={className} />;
  }
};
