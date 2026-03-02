/**
 * Styled span for rendering inline code chip tokens in the backdrop overlay.
 * Uses the same text as the textarea (transparent) to maintain pixel-perfect alignment.
 *
 * Purple color scheme to distinguish from @mention badges (blue).
 */

import type { InlineChip } from '@renderer/types/inlineChip';

const CHIP_BG = 'rgba(139, 92, 246, 0.15)';
const CHIP_TEXT = '#a78bfa';

interface CodeChipBadgeProps {
  chip: InlineChip;
  /** The full chip token text (e.g. "📄auth.ts:10-15") */
  tokenText: string;
}

export const CodeChipBadge = ({ tokenText }: CodeChipBadgeProps): React.JSX.Element => {
  return (
    <span
      style={{
        backgroundColor: CHIP_BG,
        color: CHIP_TEXT,
        borderRadius: '4px',
        boxShadow: `0 0 0 1.5px ${CHIP_BG}`,
      }}
    >
      {tokenText}
    </span>
  );
};
