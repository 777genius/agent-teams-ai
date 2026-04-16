import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StoreState {
  previewSkillImport: ReturnType<typeof vi.fn>;
  applySkillImport: ReturnType<typeof vi.fn>;
}

const storeState = {} as StoreState;
const selectFoldersMock = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/api', () => ({
  api: {
    config: {
      selectFolders: (...args: unknown[]) => selectFoldersMock(...args),
    },
  },
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
  DialogFooter: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
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
  }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) =>
    React.createElement(
      'select',
      {
        'data-testid': 'select',
        value,
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

vi.mock('@renderer/components/extensions/skills/SkillReviewDialog', () => ({
  SkillReviewDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement('div', { 'data-testid': 'skill-review-dialog' }, 'Review') : null,
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    FileSearch: Icon,
    FolderOpen: Icon,
    X: Icon,
  };
});

import { SkillImportDialog } from '@renderer/components/extensions/skills/SkillImportDialog';

describe('SkillImportDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.previewSkillImport = vi.fn();
    storeState.applySkillImport = vi.fn();
    selectFoldersMock.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps destination folder empty until a source folder is chosen', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const sourceInput = host.querySelector('#skill-import-source') as HTMLInputElement;
    const folderInput = host.querySelector('#skill-import-folder') as HTMLInputElement;

    expect(sourceInput.value).toBe('');
    expect(folderInput.value).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps destination folder name synced with the chosen source until edited manually', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    selectFoldersMock
      .mockResolvedValueOnce(['/tmp/first-skill'])
      .mockResolvedValueOnce(['/tmp/second-skill'])
      .mockResolvedValueOnce(['/tmp/third-skill']);

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const browseButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Browse')
    ) as HTMLButtonElement;
    const sourceInput = host.querySelector('#skill-import-source') as HTMLInputElement;
    const folderInput = host.querySelector('#skill-import-folder') as HTMLInputElement;

    await act(async () => {
      browseButton.click();
      await Promise.resolve();
    });

    expect(sourceInput.value).toBe('/tmp/first-skill');
    expect(folderInput.value).toBe('first-skill');

    await act(async () => {
      browseButton.click();
      await Promise.resolve();
    });

    expect(sourceInput.value).toBe('/tmp/second-skill');
    expect(folderInput.value).toBe('second-skill');

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(folderInput, 'custom-name');
      folderInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(folderInput.value).toBe('custom-name');

    await act(async () => {
      browseButton.click();
      await Promise.resolve();
    });

    expect(sourceInput.value).toBe('/tmp/third-skill');
    expect(folderInput.value).toBe('custom-name');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('sanitizes the suggested destination folder when the source folder name is not CLI-safe', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    selectFoldersMock.mockResolvedValueOnce(['/tmp/My Skill Folder']);

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const browseButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Browse')
    ) as HTMLButtonElement;

    await act(async () => {
      browseButton.click();
      await Promise.resolve();
    });

    const folderInput = host.querySelector('#skill-import-folder') as HTMLInputElement;
    expect(folderInput.value).toBe('my-skill-folder');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('falls back to user scope when the project context disappears mid-dialog', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: '/tmp/project-a',
          projectLabel: 'Project A',
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const scopeSelect = host.querySelectorAll('select')[0] as HTMLSelectElement;
    expect(scopeSelect.value).toBe('project');

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const updatedScopeSelect = host.querySelectorAll('select')[0] as HTMLSelectElement;
    expect(updatedScopeSelect.value).toBe('user');
    const projectOption = Array.from(updatedScopeSelect.options).find(
      (option) => option.value === 'project'
    ) as HTMLOptionElement;
    expect(projectOption.disabled).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('clears review state when the import dialog closes externally', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    storeState.previewSkillImport.mockResolvedValue({
      planId: 'plan-1',
      targetSkillDir: '/tmp/imported-skill',
      changes: [
        {
          relativePath: 'SKILL.md',
          absolutePath: '/tmp/imported-skill/SKILL.md',
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
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const sourceInput = host.querySelector('#skill-import-source') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(sourceInput, '/tmp/source-skill');
      sourceInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const reviewButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review And Import')
    ) as HTMLButtonElement;
    await act(async () => {
      reviewButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="skill-review-dialog"]')).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: false,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
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

  it('blocks import review locally when the folder name is invalid', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const sourceInput = host.querySelector('#skill-import-source') as HTMLInputElement;
    const folderInput = host.querySelector('#skill-import-folder') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(sourceInput, '/tmp/source-skill');
      sourceInput.dispatchEvent(new Event('input', { bubbles: true }));
      setValue?.call(folderInput, 'bad/name');
      folderInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const reviewButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review And Import')
    ) as HTMLButtonElement;
    await act(async () => {
      reviewButton.click();
      await Promise.resolve();
    });

    expect(storeState.previewSkillImport).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'Pick a simpler folder name using letters, numbers, dots, dashes, or underscores.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps review disabled for whitespace-only source folders', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SkillImportDialog, {
          open: true,
          projectPath: null,
          projectLabel: null,
          onClose: vi.fn(),
          onImported: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const sourceInput = host.querySelector('#skill-import-source') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(sourceInput, '   ');
      sourceInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const reviewButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review And Import')
    ) as HTMLButtonElement;

    expect(reviewButton.disabled).toBe(true);

    await act(async () => {
      reviewButton.click();
      await Promise.resolve();
    });

    expect(storeState.previewSkillImport).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
