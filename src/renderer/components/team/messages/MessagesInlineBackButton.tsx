import { ArrowLeft } from 'lucide-react';

import type { JSX } from 'react';

interface MessagesInlineBackButtonProps {
  label: string;
  onBack: () => void;
}

export const MessagesInlineBackButton = ({
  label,
  onBack,
}: MessagesInlineBackButtonProps): JSX.Element => {
  return (
    <button
      type="button"
      className="pointer-events-auto rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onBack();
      }}
    >
      <ArrowLeft size={14} />
    </button>
  );
};
