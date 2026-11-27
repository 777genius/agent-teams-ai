import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSavedRequest, processAlive, translate } = vi.hoisted(() => ({
  getSavedRequest: vi.fn(async () => ({ teamName: 'builders', members: [] })),
  processAlive: vi.fn(async () => true),
  translate: (key: string) => key,
}));
vi.mock('@renderer/api', () => ({ api: { teams: { getSavedRequest, processAlive } } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: translate }),
}));
vi.mock('../dialogs/EditTeamDialog', () => ({
  EditTeamDialog: ({ isTeamAlive }: { isTeamAlive: boolean }) =>
    React.createElement('div', { 'data-testid': 'editor', 'data-alive': String(isTeamAlive) }),
}));

import { TeamDefinitionEditDialog } from './TeamDefinitionEditDialog';

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe('TeamDefinitionEditDialog', () => {
  it('checks the logical team runtime before showing the live edit controls', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <TeamDefinitionEditDialog
          logicalTeamName="builders"
          onClose={() => undefined}
          onChangeLeadRuntime={() => undefined}
          onSaved={() => undefined}
        />
      );
    });
    expect(processAlive).toHaveBeenCalledWith('builders');
    expect(container.querySelector('[data-testid="editor"]')?.getAttribute('data-alive')).toBe(
      'true'
    );
  });
});
