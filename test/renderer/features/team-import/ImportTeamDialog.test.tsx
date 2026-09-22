import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  preview: {
    reviewId: 'review-1',
    suggestedTeamName: 'demo-team',
    projectPath: '/tmp/demo-team',
    members: [{ name: 'writer', workflow: 'WORKFLOW_VISIBLE_MARKER' }],
    prompt: 'PROMPT_VISIBLE_MARKER',
    skillsFound: ['editing'],
    warnings: [{ code: 'memberReserved', fileName: 'reserved.md', name: 'user' }],
    blockingErrors: [],
  },
  teamName: 'demo-team',
  setTeamName: vi.fn(),
  loading: false,
  importing: false,
  error: null,
  chooseFolder: vi.fn(),
  createDraft: vi.fn(),
}));

vi.mock('@features/team-import/renderer/hooks/useTeamImportDialog', () => ({
  useTeamImportDialog: () => hookState,
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));
vi.mock('lucide-react', () => ({
  FolderOpen: () => <svg />,
  X: () => <svg />,
}));

import { ImportTeamDialog } from '@features/team-import/renderer';

describe('ImportTeamDialog', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows the generated member workflow and lead prompt before confirmation', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => {
      root.render(<ImportTeamDialog open onClose={vi.fn()} onImported={vi.fn()} />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('WORKFLOW_VISIBLE_MARKER');
    expect(host.textContent).toContain('PROMPT_VISIBLE_MARKER');
    expect(host.textContent).toContain('/tmp/demo-team');
    expect(host.textContent).toContain('teamImport.warningMemberReserved');
    act(() => root.unmount());
  });
});
