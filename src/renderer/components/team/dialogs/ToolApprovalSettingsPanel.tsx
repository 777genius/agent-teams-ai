import React, { useState } from 'react';

import { Checkbox } from '@renderer/components/ui/checkbox';
import { useStore } from '@renderer/store';
import { ChevronDown, ChevronRight, Settings } from 'lucide-react';

import type { ToolApprovalTimeoutAction } from '@shared/types';

export const ToolApprovalSettingsPanel: React.FC = () => {
  const [expanded, setExpanded] = useState(false);
  const [localSeconds, setLocalSeconds] = useState<string>('');
  const settings = useStore((s) => s.toolApprovalSettings);
  const updateSettings = useStore((s) => s.updateToolApprovalSettings);

  return (
    <div className="border-t px-4 py-2" style={{ borderColor: 'var(--color-border)' }}>
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
        onMouseEnter={(e) => {
          Object.assign(e.currentTarget.style, {
            backgroundColor: 'var(--color-surface-raised)',
          });
        }}
        onMouseLeave={(e) => {
          Object.assign(e.currentTarget.style, { backgroundColor: 'transparent' });
        }}
      >
        <Settings className="size-3" />
        <span>Settings</span>
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>

      {/* Collapsible panel */}
      {expanded && (
        <div
          className="mt-2 space-y-3 rounded-md border p-3"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
        >
          {/* Auto-allow file edits */}
          <label
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Checkbox
              checked={settings.autoAllowFileEdits}
              onCheckedChange={(checked) =>
                void updateSettings({ autoAllowFileEdits: checked === true })
              }
            />
            Auto-allow file edits (Edit, Write, NotebookEdit)
          </label>

          {/* Auto-allow safe bash */}
          <label
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Checkbox
              checked={settings.autoAllowSafeBash}
              onCheckedChange={(checked) =>
                void updateSettings({ autoAllowSafeBash: checked === true })
              }
            />
            Auto-allow safe commands (git, pnpm, npm, ls...)
          </label>

          {/* Separator */}
          <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />

          {/* Timeout section */}
          <div
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <span className="shrink-0">On timeout:</span>
            <select
              value={settings.timeoutAction}
              onChange={(e) =>
                void updateSettings({ timeoutAction: e.target.value as ToolApprovalTimeoutAction })
              }
              className="rounded border px-1.5 py-0.5 text-xs"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text)',
              }}
            >
              <option value="wait">Wait forever</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>

            {settings.timeoutAction !== 'wait' && (
              <>
                <span className="shrink-0">after</span>
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={localSeconds !== '' ? localSeconds : String(settings.timeoutSeconds)}
                  onChange={(e) => setLocalSeconds(e.target.value)}
                  onBlur={() => {
                    const val = parseInt(localSeconds, 10);
                    if (!isNaN(val) && val >= 5 && val <= 300) {
                      void updateSettings({ timeoutSeconds: val });
                    }
                    setLocalSeconds('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  className="w-14 rounded border px-1.5 py-0.5 text-center text-xs"
                  style={{
                    backgroundColor: 'var(--color-surface-raised)',
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                />
                <span className="shrink-0">sec</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
