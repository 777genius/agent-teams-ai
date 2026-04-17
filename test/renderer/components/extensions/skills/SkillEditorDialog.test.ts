import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillDetail } from '@shared/types/extensions';

interface StoreState {
  previewSkillUpsert: ReturnType<typeof vi.fn>;
  applySkillUpsert: ReturnType<typeof vi.fn>;
}

const storeState = {} as StoreState;

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/hooks/useMarkdownScrollSync', () => ({
  useMarkdownScrollSync: () => ({
    handleCodeScroll: vi.fn(),
    handlePreviewScroll: vi.fn(),
    previewScrollRef: { current: null },
  }),
}));

vi.mock('@renderer/components/team/editor/MarkdownPreviewPane', () => ({
  MarkdownPreviewPane: () => React.createElement('div', null, 'Preview'),
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

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
    className?: string;
  }) =>
    React.createElement('input', {
      type: 'checkbox',
      checked,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.target.checked),
    }),
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

vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', props),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children, htmlFor }: React.PropsWithChildren<{ htmlFor?: string }>) =>
    React.createElement('label', { htmlFor }, children),
}));

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: React.PropsWithChildren<{
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }>) =>
    React.createElement(
      'select',
      {
        value,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value),
      },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  SelectItem: ({
    children,
    value,
    disabled,
  }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) =>
    React.createElement('option', { value, disabled }, children),
}));

vi.mock('@renderer/components/ui/textarea', () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
    React.createElement('textarea', props),
}));

vi.mock('@renderer/components/extensions/skills/SkillCodeEditor', () => ({
  SkillCodeEditor: () => React.createElement('div', null, 'Editor'),
}));

vi.mock('@renderer/components/extensions/skills/SkillReviewDialog', () => ({
  SkillReviewDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement('div', { 'data-testid': 'skill-review-dialog' }, 'Review') : null,
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    FileSearch: Icon,
    RotateCcw: Icon,
    X: Icon,
  };
});

import { SkillEditorDialog } from '@renderer/components/extensions/skills/SkillEditorDialog';

function makeDetail(rawContent: string): SkillDetail {
  return {
    item: {
      id: '/tmp/project/.claude/skills/custom-skill',
      sourceType: 'filesystem',
      name: 'Custom Skill',
      description: 'Custom markdown skill',
      folderName: 'custom-skill',
      scope: 'project',
      rootKind: 'claude',
      projectRoot: '/tmp/project',
      discoveryRoot: '/tmp/project/.claude/skills',
      skillDir: '/tmp/project/.claude/skills/custom-skill',
      skillFile: '/tmp/project/.claude/skills/custom-skill/SKILL.md',
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
    },
    body: rawContent,
    rawContent,
    rawFrontmatter: null,
    referencesFiles: [],
    scriptFiles: [],
    assetFiles: [],
  };
}

describe('SkillEditorDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.previewSkillUpsert = vi.fn();
    storeState.applySkillUpsert = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('unlocks structured editing after resetting a custom markdown skill', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const detail = makeDetail(`---
name: Custom Skill
description: Custom markdown skill
---

# Custom Skill

This file uses a freeform layout without generated sections.
`);

    await act(async () => {
      root.render(
        React.createElement(SkillEditorDialog, {
          open: true,
          mode: 'edit',
          projectPath: '/tmp/project',
          projectLabel: 'Project',
          detail,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('#skill-when-to-use')).toBeNull();

    const resetButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Reset From Structured Fields')
    ) as HTMLButtonElement;
    expect(resetButton).toBeDefined();

    await act(async () => {
      resetButton.click();
      await Promise.resolve();
    });

    const whenToUseField = host.querySelector('#skill-when-to-use') as HTMLTextAreaElement;
    expect(whenToUseField).not.toBeNull();
    expect(whenToUseField.disabled).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('clears review state when the editor closes externally', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    storeState.previewSkillUpsert.mockResolvedValue({
      planId: 'plan-1',
      targetSkillDir: '/tmp/project/.claude/skills/new-skill',
      changes: [
        {
          relativePath: 'SKILL.md',
          absolutePath: '/tmp/project/.claude/skills/new-skill/SKILL.md',
          action: 'create',
          oldContent: null,
          newContent: '# Skill',
          isBinary: false,
        },
      ],
      warnings: [],
      summary: { created: 1, updated: 0, deleted: 0, binary: 0 },
    });

    await act(async () => {
      root.render(
        React.createElement(SkillEditorDialog, {
          open: true,
          mode: 'create',
          projectPath: '/tmp/project',
          projectLabel: 'Project',
          detail: null,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const reviewButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review And Create')
    ) as HTMLButtonElement;
    await act(async () => {
      reviewButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="skill-review-dialog"]')).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(SkillEditorDialog, {
          open: false,
          mode: 'create',
          projectPath: '/tmp/project',
          projectLabel: 'Project',
          detail: null,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="skill-review-dialog"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('blocks review locally when the folder name is invalid', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SkillEditorDialog, {
          open: true,
          mode: 'create',
          projectPath: '/tmp/project',
          projectLabel: 'Project',
          detail: null,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const folderInput = host.querySelector('#skill-folder') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(folderInput, 'bad/name');
      folderInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const reviewButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review And Create')
    ) as HTMLButtonElement;
    await act(async () => {
      reviewButton.click();
      await Promise.resolve();
    });

    expect(storeState.previewSkillUpsert).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'Pick a simpler folder name using letters, numbers, dots, dashes, or underscores.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
