import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { OptionalSettingsSection } from '@renderer/components/team/dialogs/OptionalSettingsSection';
import { TeamHistoryModeField } from '@renderer/components/team/dialogs/TeamHistoryModeField';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { selectOwnerRoutingSharedHistory } from '../../../../../scripts/legacy-agent-host/desktop-owner-routing-history-ui';

import type { TeamProjectContextMode } from '@shared/types';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => ({
    'create.projectContextMode.label': 'Team history',
    'create.projectContextMode.perProject': 'Separate tasks and chats for each project (default)',
    'create.projectContextMode.shared': 'Shared across projects',
  }[key] ?? key) }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));

const cleanups: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function fixture(expanded = false, duplicate = false) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let selected: TeamProjectContextMode = 'per_project';
  function OriginalCreationFields() {
    const [mode, setMode] = useState<TeamProjectContextMode>('per_project');
    return <div data-testid="create-team-page">
      <OptionalSettingsSection title="Optional settings" description="History only" defaultOpen={expanded}>
        <TeamHistoryModeField value={mode} onValueChange={value => { selected = value; setMode(value); }} />
      </OptionalSettingsSection>
      {duplicate && <OptionalSettingsSection title="Optional settings" description="Ambiguous original"><span /></OptionalSettingsSection>}
    </div>;
  }
  act(() => root.render(<OriginalCreationFields />));
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  const clicks: string[] = [];
  const ui: Parameters<typeof selectOwnerRoutingSharedHistory>[0] = {
    async waitRead(expression, label, _timeout, ready = Boolean) {
      const value = Function('document', `return (${expression});`)(document);
      if (!ready(value)) throw new Error(label);
      return value;
    },
    async scrollTo(selector) {
      expect(document.querySelector(selector)).not.toBeNull();
    },
    async click(selector, label, text) {
      const elements = [...document.querySelectorAll<HTMLElement>(selector)]
        .filter(e => text === undefined || e.textContent?.trim() === text);
      expect(elements).toHaveLength(1);
      clicks.push(label);
      await act(async () => {
        const element = elements[0]!;
        if (element.getAttribute('role') === 'combobox' || element.getAttribute('role') === 'option') {
          element.focus();
          element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        } else element.click();
      });
    },
  };
  return { run: () => selectOwnerRoutingSharedHistory(ui), clicks, selected: () => selected };
}

it.each([false, true])('selects shared history through the real creation controls with expanded=%s', async expanded => {
  const f = fixture(expanded);
  await f.run();
  expect(f.selected()).toBe('shared');
  expect(f.clicks).toEqual([
    ...(!expanded ? ['expand original save-only history settings'] : []),
    'open original Team history choice', 'select shared original owner history',
  ]);
});

it('refuses an ambiguous original section without changing any history mode', async () => {
  const f = fixture(false, true);
  await expect(f.run()).rejects.toThrow('original save-only history settings');
  expect(f.selected()).toBe('per_project');
  expect(f.clicks).toEqual([]);
});
