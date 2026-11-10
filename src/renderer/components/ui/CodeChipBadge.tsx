/**
 * Styled span for rendering inline code chip tokens in the backdrop overlay.
 * Uses the same text as the textarea (transparent) to maintain pixel-perfect alignment.
 *
 * Purple color scheme to distinguish from @mention badges (blue).
 * Folder chips use a teal color scheme to distinguish from file chips.
 */

import type { InlineChip } from '@renderer/types/inlineChip';

const CHIP_BG = 'rgba(139, 92, 246, 0.15)';
const CHIP_TEXT = '#a78bfa';
const FOLDER_CHIP_BG = 'rgba(45, 212, 191, 0.15)';
const FOLDER_CHIP_TEXT = '#5eead4';

interface CodeChipBadgeProps {
  chip: InlineChip;
  /** The full chip token text (e.g. "📄auth.ts:10-15") */
  tokenText: string;
}

export const CodeChipBadge = ({ chip, tokenText }: CodeChipBadgeProps): React.JSX.Element => {
  const bg = chip.isFolder ? FOLDER_CHIP_BG : CHIP_BG;
  const text = chip.isFolder ? FOLDER_CHIP_TEXT : CHIP_TEXT;
  return (
    <span
      style={{
        backgroundColor: bg,
        color: text,
        borderRadius: '4px',
        boxShadow: `0 0 0 1.5px ${bg}`,
      }}
    >
      {tokenText}
    </span>
  );
};
