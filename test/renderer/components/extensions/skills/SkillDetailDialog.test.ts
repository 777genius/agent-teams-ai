import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillDetail } from '@shared/types/extensions';

interface StoreState {
  fetchSkillDetail: ReturnType<typeof vi.fn>;
  deleteSkill: ReturnType<typeof vi.fn>;
  skillsDetailsById: Record<string, SkillDetail | null | undefined>;
  skillsDetailLoadingById: Record<string, boolean>;
  skillsDetailErrorById: Record<string, string | null>;
}

const storeState = {} as StoreState;
const openPathMock = vi.fn();
const showInFolderMock = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@renderer/api', () => ({
  api: {
    openPath: (...args: unknown[]) => openPathMock(...args),
    showInFolder: (...args: unknown[]) => showInFolderMock(...args),
  },
}));

vi.mock('@renderer/components/chat/viewers/CodeBlockViewer', () => ({
  CodeBlockViewer: () => React.createElement('div', null, 'Code'),
}));

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: () => React.createElement('div', null, 'Markdown'),
}));

vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: ({
    open,
    children,
  }: React.PropsWithChildren<{
    open: boolean;
    onOpenChange?: (next: boolean) => void;
  }>) => (open ? React.createElement('div', null, children) : null),
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) =>
    React.createElement(
      'button',
      {
        type: 'button',
        disabled,
        onClick,
      },
      children
    ),
  AlertDialogCancel: ({ children }: React.PropsWithChildren<{ disabled?: boolean }>) =>
    React.createElement('button', { type: 'button' }, children),
  AlertDialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  AlertDialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('p', null, children),
  AlertDialogFooter: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  AlertDialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  AlertDialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('h3', null, children),
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type = 'button',
    disabled,
  }: React.PropsWithChildren<{
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
  }>) =>
    React.createElement(
      'button',
      {
        type,
        disabled,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('p', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('h2', null, children),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    ExternalLink: Icon,
    FolderOpen: Icon,
    Info: Icon,
    Pencil: Icon,
    Trash2: Icon,
  };
});

import { SkillDetailDialog } from '@renderer/components/extensions/skills/SkillDetailDialog';

function makeDetail(overrides: Partial<SkillDetail['item']>): SkillDetail {
  return {
    item: {
      id: '/tmp/project-a/.claude/skills/review-helper',
      sourceType: 'filesystem',
      name: 'Review Helper',
      description: 'Helps with code review',
      folderName: 'review-helper',
      scope: 'project',
      rootKind: 'claude',
      projectRoot: '/tmp/project-a',
      discoveryRoot: '/tmp/project-a/.claude/skills',
      skillDir: '/tmp/project-a/.claude/skills/review-helper',
      skillFile: '/tmp/project-a/.claude/skills/review-helper/SKILL.md',
      metadata: {},
      invocationMode: 'auto',
      flags: {
        hasScripts: false,
        hasReferences: false,
        hasAssets: false,
      },
      isValid: true,
      issues: [],
      modifiedAt: 1,
      ...overrides,
    },
    body: 'body',
    rawContent: '# Review Helper',
    rawFrontmatter: null,
    referencesFiles: [],
    scriptFiles: [],
    assetFiles: [],
  };
}

describe('SkillDetailDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.fetchSkillDetail = vi.fn().mockResolvedValue(undefined);
    storeState.deleteSkill = vi.fn().mockResolvedValue(undefined);
    storeState.skillsDetailsById = {};
    storeState.skillsDetailLoadingById = {};
    storeState.skillsDetailErrorById = {};
    openPathMock.mockReset();
    showInFolderMock.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses the skill project root for project-scoped open and delete actions', async () => {
    const detail = makeDetail({});
    storeState.skillsDetailsById[detail.item.id] = detail;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onDeleted = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(SkillDetailDialog, {
          skillId: detail.item.id,
          open: true,
          onClose: vi.fn(),
          projectPath: '/tmp/project-b',
          onEdit: vi.fn(),
          onDeleted,
        })
      );
      await Promise.resolve();
    });

    const openButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Open SKILL.md')
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.click();
      await Promise.resolve();
    });

    expect(openPathMock).toHaveBeenCalledWith(detail.item.skillFile, '/tmp/project-a');

    const deleteButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent === 'Delete'
    ) as HTMLButtonElement;
    await act(async () => {
      deleteButton.click();
      await Promise.resolve();
    });

    const confirmDeleteButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent === 'Delete Skill'
    ) as HTMLButtonElement;
    await act(async () => {
      confirmDeleteButton.click();
      await Promise.resolve();
    });

    expect(storeState.deleteSkill).toHaveBeenCalledWith({
      skillId: detail.item.id,
      projectPath: '/tmp/project-a',
    });
    expect(onDeleted).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not forward the current project path for personal skills', async () => {
    const detail = makeDetail({
      id: '/Users/me/.claude/skills/review-helper',
      scope: 'user',
      projectRoot: null,
      discoveryRoot: '/Users/me/.claude/skills',
      skillDir: '/Users/me/.claude/skills/review-helper',
      skillFile: '/Users/me/.claude/skills/review-helper/SKILL.md',
    });
    storeState.skillsDetailsById[detail.item.id] = detail;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SkillDetailDialog, {
          skillId: detail.item.id,
          open: true,
          onClose: vi.fn(),
          projectPath: '/tmp/project-b',
          onEdit: vi.fn(),
          onDeleted: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const openButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Open SKILL.md')
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.click();
      await Promise.resolve();
    });

    expect(openPathMock).toHaveBeenCalledWith(detail.item.skillFile, undefined);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders script-only advisory issues as informational copy', async () => {
    const detail = makeDetail({
      flags: {
        hasScripts: true,
        hasReferences: false,
        hasAssets: false,
      },
      issues: [
        {
          code: 'has-scripts',
          message: 'This skill includes a scripts directory. Review bundled scripts before trusting it.',
          severity: 'info',
        },
      ],
    });
    storeState.skillsDetailsById[detail.item.id] = detail;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SkillDetailDialog, {
          skillId: detail.item.id,
          open: true,
          onClose: vi.fn(),
          projectPath: '/tmp/project-a',
          onEdit: vi.fn(),
          onDeleted: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('This skill includes bundled scripts');
    expect(host.textContent).toContain(
      'This skill includes a scripts directory. Review bundled scripts before trusting it.'
    );
    expect(host.textContent).not.toContain('Review this skill carefully before using it');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
