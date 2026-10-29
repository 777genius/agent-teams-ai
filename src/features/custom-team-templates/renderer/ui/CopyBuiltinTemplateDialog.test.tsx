import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyBuiltinTemplate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: { customTeamTemplates: { copyBuiltinTemplate } },
}));

// A real Russian lookup for built-in names: the catalogue name must differ from
// the English `TEAM_TEMPLATES` value, which is what makes the seeding
// assertion meaningful.
vi.mock('@features/localization/renderer', async () => {
  const { default: ruTeam } = await import('@features/localization/renderer/locales/ru/team.json');
  const templates = (
    ruTeam as {
      templates: { names: Record<string, string>; descriptions: Record<string, string> };
    }
  ).templates;
  return {
    useAppTranslation: () => ({
      t: (key: string, values?: Record<string, unknown>) => {
        const builtin = /^templates\.names\.(.+)$/.exec(key);
        if (builtin) {
          return templates.names[builtin[1]] ?? key;
        }
        const description = /^templates\.descriptions\.(.+)$/.exec(key);
        if (description) {
          return templates.descriptions[description[1]] ?? key;
        }
        return values
          ? `${key}|${Object.entries(values)
              .map(([name, value]) => `${name}=${String(value)}`)
              .join(';')}`
          : key;
      },
    }),
  };
});

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (next: boolean) => void;
    children: React.ReactNode;
  }) => (open ? React.createElement('div', null, children) : null),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

import ruTeam from '@features/localization/renderer/locales/ru/team.json';
import { TEAM_TEMPLATES } from '@features/team-templates';

import { CopyBuiltinTemplateDialog } from './CopyBuiltinTemplateDialog';

import type { CopyBuiltinTemplateResult } from '@features/custom-team-templates/contracts';

const RU_TEMPLATES = (
  ruTeam as {
    templates: { names: Record<string, string>; descriptions: Record<string, string> };
  }
).templates;
const RU_SOFTWARE = RU_TEMPLATES.names['software-product'];
const RU_MARKETING = RU_TEMPLATES.names.marketing;
const RU_SOFTWARE_DESCRIPTION = RU_TEMPLATES.descriptions['software-product'];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;
let onCopied: ReturnType<typeof vi.fn>;

function render(): Promise<void> {
  return act(async () => {
    root.render(<CopyBuiltinTemplateDialog open onClose={onClose} onCopied={onCopied} />);
  });
}

function rerender(): Promise<void> {
  return render();
}

function nameInput(): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>('#copy-builtin-name');
  if (!field) throw new Error(`name field not found\n${host.textContent}`);
  return field;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!found) throw new Error(`button not found: ${label}\n${host.textContent}`);
  return found;
}

function setText(value: string): void {
  const field = nameInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectBuiltin(id: string): Promise<void> {
  return act(async () => {
    host.querySelector<HTMLButtonElement>(`[data-testid="builtin-template-${id}"]`)?.click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  copyBuiltinTemplate.mockReset();
  copyBuiltinTemplate.mockResolvedValue({
    status: 'copied',
    template: {
      templateId: 'tmpl-1',
      name: RU_SOFTWARE,
      schemaVersion: 1,
      teamPrompt: 'Ship.',
      members: [{ name: 'lead' }],
      revision: 1,
    },
  } satisfies CopyBuiltinTemplateResult);
  onClose = vi.fn();
  onCopied = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('CopyBuiltinTemplateDialog localization', () => {
  it('renders every built-in name through the localized catalogue lookup', async () => {
    await render();
    const grid = host.querySelector('[data-testid="builtin-templates-list"]');
    expect(grid).not.toBeNull();
    expect(grid?.textContent).toContain(RU_SOFTWARE);
    expect(grid?.textContent).toContain(RU_MARKETING);
    // Descriptions follow the same localized lookup as the catalogue.
    expect(grid?.textContent).toContain(RU_SOFTWARE_DESCRIPTION);
    // The English catalogue value must not leak into the localized UI.
    expect(grid?.textContent).not.toContain('Software Product Team');
    expect(grid?.textContent).not.toContain(TEAM_TEMPLATES[0].description);
    expect(host.querySelector('[data-testid="builtin-preview"]')?.textContent).toContain(
      RU_SOFTWARE
    );
  });

  it('seeds the editable name from the localized built-in name', async () => {
    await render();
    expect(nameInput().value).toBe(RU_SOFTWARE);
  });

  it('copies the localized default name when the user does not edit it', async () => {
    await render();
    await act(async () => {
      button('customTemplates.copyBuiltin.action').click();
    });

    expect(copyBuiltinTemplate).toHaveBeenCalledWith({
      builtinTemplateId: 'software-product',
      name: RU_SOFTWARE,
    });
    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('updates the label and the default name when another built-in is selected', async () => {
    await render();
    await selectBuiltin('marketing');
    expect(nameInput().value).toBe(RU_MARKETING);
    expect(host.querySelector('[data-testid="builtin-preview"]')?.textContent).toContain(
      RU_MARKETING
    );
  });

  it('does not overwrite an explicitly edited name on rerender', async () => {
    await render();
    await act(async () => {
      setText('My own copy');
    });
    await rerender();
    expect(nameInput().value).toBe('My own copy');

    await act(async () => {
      button('customTemplates.copyBuiltin.action').click();
    });
    expect(copyBuiltinTemplate).toHaveBeenCalledWith({
      builtinTemplateId: 'software-product',
      name: 'My own copy',
    });
  });

  it('keeps every built-in id resolvable through the localized lookup', async () => {
    await render();
    for (const template of TEAM_TEMPLATES) {
      const card = host.querySelector(`[data-testid="builtin-template-${template.id}"]`);
      expect(card).not.toBeNull();
      // A resolved translation never renders the raw key.
      expect(card?.textContent).not.toContain('templates.names.');
      expect(card?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('CopyBuiltinTemplateDialog unresolved outcome', () => {
  beforeEach(() => {
    copyBuiltinTemplate.mockResolvedValue({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-1',
    } satisfies CopyBuiltinTemplateResult);
  });

  it('reports that the copy could not be confirmed without closing or retrying', async () => {
    await render();
    await act(async () => {
      button('customTemplates.copyBuiltin.action').click();
    });

    const alert = host.querySelector('[data-testid="copy-builtin-unresolved"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedTitle');
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedMutationBody');

    // The copy is not reported as success and is never retried automatically.
    expect(onCopied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(copyBuiltinTemplate).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="copy-builtin-storage-unavailable"]')).toBeNull();

    // The selection and the name stay available for recovery.
    expect(nameInput().value).toBe(RU_SOFTWARE);
    expect(
      host
        .querySelector('[data-testid="builtin-template-software-product"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
  });
});
