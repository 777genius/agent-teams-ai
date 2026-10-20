import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listTemplates = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  api: {
    customTeamTemplates: {
      listTemplates,
    },
  },
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}|${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(';')}`
        : key,
  }),
}));

import { TEAM_TEMPLATES } from '@features/team-templates';

import { CreateTeamTemplatePicker } from './CreateTeamTemplatePicker';

import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';

function customTemplates(): CustomTeamTemplateV1[] {
  return [
    {
      templateId: 'tmpl-custom-1',
      name: 'Custom One',
      description: 'Custom description',
      schemaVersion: 1,
      teamPrompt: 'Custom prompt',
      members: [{ name: 'backend-dev', role: 'Backend Developer', workflow: 'Build APIs' }],
      revision: 2,
      createdAt: '2026-09-10T10:00:00.000Z',
    },
  ];
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onApply: ReturnType<typeof vi.fn>;

function renderPicker(open = true): void {
  root.render(<CreateTeamTemplatePicker open={open} onApply={onApply} />);
}

async function flush(): Promise<void> {
  await act(async () => {});
  await act(async () => {});
}

function optionNone(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('[data-testid="create-template-option-none"]');
}

function optionBuiltin(id: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    `[data-testid="create-template-option-builtin-${id}"]`
  );
}

function optionCustom(templateId: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    `[data-testid="create-template-option-custom-${templateId}"]`
  );
}

async function click(element: HTMLButtonElement | null): Promise<void> {
  if (!element) throw new Error('expected option button not found');
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listTemplates.mockReset();
  onApply = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('CreateTeamTemplatePicker', () => {
  it('keeps the no-template default without applying anything on mount', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: customTemplates() });
    renderPicker(true);
    await flush();

    expect(listTemplates).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(optionNone()?.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('customTemplates.createFromTemplate.noneHint');
    // Built-in and custom templates stay clearly distinguishable.
    expect(optionBuiltin('marketing')).not.toBeNull();
    expect(optionCustom('tmpl-custom-1')).not.toBeNull();
  });

  it('does not load the library while the dialog is closed', async () => {
    renderPicker(false);
    await flush();

    expect(listTemplates).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows loading state without blocking the no-template and built-in options', async () => {
    let resolveLoad: (value: unknown) => void = () => {};
    listTemplates.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    renderPicker(true);
    await act(async () => {});

    expect(host.textContent).toContain('customTemplates.library.loading');
    expect(optionNone()).not.toBeNull();
    expect(optionBuiltin('marketing')).not.toBeNull();

    await act(async () => {
      resolveLoad({ status: 'ready', templates: customTemplates() });
    });
    await flush();
    expect(optionCustom('tmpl-custom-1')).not.toBeNull();
  });

  it('handles an empty custom library gracefully', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'empty' });
    renderPicker(true);
    await flush();

    expect(host.querySelector('[data-testid="create-template-custom-empty"]')).not.toBeNull();
    expect(optionBuiltin('research')).not.toBeNull();
    expect(optionNone()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows library failures with a working retry', async () => {
    listTemplates.mockRejectedValueOnce(new Error('offline'));
    renderPicker(true);
    await flush();

    expect(host.querySelector('[data-testid="create-template-library-error"]')).not.toBeNull();
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: customTemplates() });
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="create-template-retry"]');
    await click(retry);
    await flush();

    expect(listTemplates).toHaveBeenCalledTimes(2);
    expect(optionCustom('tmpl-custom-1')).not.toBeNull();
  });

  it('applies a built-in template draft with a read-only preview', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'empty' });
    renderPicker(true);
    await flush();

    await click(optionBuiltin('marketing'));

    expect(onApply).toHaveBeenCalledTimes(1);
    const draft = onApply.mock.calls[0][0] as Record<string, unknown>;
    expect(onApply.mock.calls[0][1]).toBe('builtin');
    const marketing = TEAM_TEMPLATES.find((entry) => entry.id === 'marketing');
    expect(draft.description).toBe(marketing?.description);
    expect(draft.prompt).toBe(marketing?.teamPrompt);
    expect(draft.members).toEqual(
      marketing?.members.map((member) => ({
        name: member.name,
        role: member.role,
        workflow: member.workflow,
      }))
    );
    expect(draft.runtimeSelectionVersion).toBe(1);
    expect(optionBuiltin('marketing')?.getAttribute('aria-pressed')).toBe('true');
    const preview = host.querySelector('[data-testid="create-template-preview"]');
    expect(preview?.textContent).toContain(marketing?.teamPrompt);
    expect(preview?.textContent).toContain('customTemplates.createFromTemplate.readOnlySource');
  });

  it('applies a custom template draft without leaking its identity', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: customTemplates() });
    renderPicker(true);
    await flush();

    await click(optionCustom('tmpl-custom-1'));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(
      {
        runtimeSelectionVersion: 1,
        description: 'Custom description',
        prompt: 'Custom prompt',
        members: [{ name: 'backend-dev', role: 'Backend Developer', workflow: 'Build APIs' }],
        syncModelsWithLead: true,
      },
      'custom'
    );
    const preview = host.querySelector('[data-testid="create-template-preview"]');
    expect(preview?.textContent).toContain('Custom prompt');
    expect(preview?.textContent).toContain('customTemplates.createFromTemplate.sourceCustom');
  });

  it('replaces the previous draft wholesale when switching templates', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: customTemplates() });
    renderPicker(true);
    await flush();

    await click(optionBuiltin('marketing'));
    await click(optionCustom('tmpl-custom-1'));

    expect(onApply).toHaveBeenCalledTimes(2);
    const second = onApply.mock.calls[1][0] as { members: unknown[] };
    expect(second.members).toEqual([
      { name: 'backend-dev', role: 'Backend Developer', workflow: 'Build APIs' },
    ]);
    expect(optionBuiltin('marketing')?.getAttribute('aria-pressed')).toBe('false');
    expect(optionCustom('tmpl-custom-1')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('restores a blank draft when switching back to no template', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: customTemplates() });
    renderPicker(true);
    await flush();

    await click(optionCustom('tmpl-custom-1'));
    await click(optionNone());

    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(
      {
        runtimeSelectionVersion: 1,
        description: '',
        prompt: '',
        members: [],
        syncModelsWithLead: true,
      },
      'none'
    );
  });

  it('warns about a deleted custom template and allows recovery', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: customTemplates() });
    renderPicker(true);
    await flush();
    await click(optionCustom('tmpl-custom-1'));
    expect(onApply).toHaveBeenCalledTimes(1);

    // The template is deleted elsewhere; reopening reloads the library.
    listTemplates.mockResolvedValueOnce({ status: 'empty' });
    root.render(<CreateTeamTemplatePicker open={false} onApply={onApply} />);
    await flush();
    root.render(<CreateTeamTemplatePicker open onApply={onApply} />);
    await flush();

    expect(host.querySelector('[data-testid="create-template-stale"]')).not.toBeNull();
    // The previously applied snapshot stays visible for an informed choice.
    expect(host.querySelector('[data-testid="create-template-preview"]')?.textContent).toContain(
      'Custom prompt'
    );

    await click(optionBuiltin('research'));
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="create-template-stale"]')).toBeNull();
  });

  it('ignores repeated clicks on the active option without sending any creation request', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'empty' });
    renderPicker(true);
    await flush();

    await click(optionBuiltin('research'));
    await click(optionBuiltin('research'));

    expect(onApply).toHaveBeenCalledTimes(1);
    // The picker only ever reads the library; creation stays on dialog submit.
    expect(listTemplates).toHaveBeenCalledTimes(1);
  });

  it('keeps selection controls keyboard-focusable with accessible pressed state', async () => {
    listTemplates.mockResolvedValueOnce({ status: 'ready', templates: customTemplates() });
    renderPicker(true);
    await flush();

    for (const button of [
      optionNone(),
      optionBuiltin('marketing'),
      optionCustom('tmpl-custom-1'),
    ]) {
      expect(button?.tagName).toBe('BUTTON');
      expect(button?.getAttribute('type')).toBe('button');
      expect(button?.hasAttribute('aria-pressed')).toBe(true);
    }
  });
});
