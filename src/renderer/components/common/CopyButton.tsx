import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Check, Copy } from 'lucide-react';

interface CopyButtonProps {
  /** Text to copy to clipboard */
  text: string;
  /** Background color the gradient fades into (must match parent surface) */
  bgColor?: string;
  /** Render as inline element instead of absolute overlay */
  inline?: boolean;
}

/**
 * Copy-to-clipboard button with two modes:
 *
 * **Overlay** (default): Absolute-positioned in top-right corner, visible on
 * group hover. A horizontal gradient fades from transparent to `bgColor` so
 * text behind the button isn't abruptly covered.
 * Requires an ancestor with `group` and `relative` classes.
 *
 * **Inline** (`inline`): Normal-flow button for use inside headers/toolbars.
 */
export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  bgColor = 'var(--code-bg)',
  inline = false,
}) => {
  const { t } = useAppTranslation('common');
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Silently fail — clipboard API may be unavailable
    }
  };

  const icon = isCopied ? (
    <Check className="size-3.5" style={{ color: 'var(--badge-success-bg)' }} />
  ) : (
    <Copy className="size-3.5" style={{ color: 'var(--color-text-muted)' }} />
  );

  if (inline) {
    return (
      <button
        onClick={handleCopy}
        className="rounded p-1 transition-colors hover:opacity-80"
        title={t('actions.copyToClipboard')}
      >
        {icon}
      </button>
    );
  }

  const isTransparent = bgColor === 'transparent';

  return (
    <div className="pointer-events-none absolute right-0 top-0 z-10 flex opacity-0 transition-opacity group-hover:opacity-100">
      {/* Gradient fade from transparent to bgColor so text isn't obscured */}
      {!isTransparent && (
        <div
          className="w-8 self-stretch"
          style={{ background: `linear-gradient(to right, transparent, ${bgColor})` }}
        />
      )}
      {/* Solid background holding the button */}
      <div
        className="rounded-bl-lg p-1.5"
        style={isTransparent ? undefined : { backgroundColor: bgColor }}
      >
        <button
          onClick={handleCopy}
          className="pointer-events-auto rounded p-1.5"
          title={t('actions.copyToClipboard')}
        >
          {icon}
        </button>
      </div>
    </div>
  );
};
