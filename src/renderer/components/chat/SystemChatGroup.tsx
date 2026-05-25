import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { format } from 'date-fns';
import { Terminal } from 'lucide-react';

import type { SystemGroup } from '@renderer/types/groups';

// Module-level constant - safe because .replace() resets lastIndex on g-flagged regexes
const ANSI_ESCAPE_REGEX = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

interface SystemChatGroupProps {
  systemGroup: SystemGroup;
}

/**
 * SystemChatGroup displays command output (e.g., /model response).
 * Renders on LEFT side like AI, but with neutral/gray styling.
 */
const SystemChatGroupInner = ({
  systemGroup,
}: Readonly<SystemChatGroupProps>): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const { commandOutput, timestamp } = systemGroup;

  // Clean ANSI escape codes from output
  const cleanOutput = commandOutput.replace(ANSI_ESCAPE_REGEX, '');

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        {/* Header - system icon */}
        <div
          className="flex items-center gap-2 text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Terminal className="size-3.5" style={{ color: 'var(--color-text-muted)' }} />
          <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            {t('chat.system.label')}
          </span>
          <span>·</span>
          <span>{format(timestamp, 'h:mm:ss a')}</span>
        </div>

        {/* Content - theme-aware neutral styling */}
        <div
          className="rounded-2xl rounded-bl-sm px-4 py-3"
          style={{ backgroundColor: 'var(--chat-system-bg)' }}
        >
          <pre
            className="whitespace-pre-wrap font-mono text-sm"
            style={{ color: 'var(--chat-system-text)' }}
          >
            {cleanOutput}
          </pre>
        </div>
      </div>
    </div>
  );
};

export const SystemChatGroup = React.memo(SystemChatGroupInner);
