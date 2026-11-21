import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const duplicateTemplate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: { customTeamTemplates: { duplicateTemplate } },
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

import { DuplicateCustomTemplateDialog } from './DuplicateCustomTemplateDialog';

import type {
  CustomTeamTemplateV1,
  DuplicateCustomTeamTemplateResult,
} from '@features/custom-team-templates/contracts';

const template: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  schemaVersion: 1,
  teamPrompt: 'Ship.',
  members: [{ name: 'alice' }],
  revision: 2,
};

const duplicate: CustomTeamTemplateV1 = {
  ...template,
  templateId: 'tmpl-2',
  name: 'Release Pipeline (copy)',
  revision: 1,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;
let onDuplicated: ReturnType<typeof vi.fn>;

function render(): Promise<void> {
  return act(async () => {
    root.render(
      <DuplicateCustomTemplateDialog
        open
        template={template}
        onClose={onClose}
        onDuplicated={onDuplicated}
      />
    );
  });
}

function nameInput(): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>('#duplicate-template-name');
  if (!field) throw new Error(`name field not found\n${host.textContent}`);
  return field;
}

function actionButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('customTemplates.duplicate.action')
  );
  if (!found) throw new Error(`action button not found\n${host.textContent}`);
  return found;
}

async function duplicateOnce(): Promise<void> {
  await act(async () => {
    actionButton().click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  duplicateTemplate.mockReset();
  duplicateTemplate.mockResolvedValue({
    status: 'duplicated',
    template: duplicate,
  } satisfies DuplicateCustomTeamTemplateResult);
  onClose = vi.fn();
  onDuplicated = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('DuplicateCustomTemplateDialog', () => {
  it('proposes a default name and closes on a confirmed duplicate', async () => {
    await render();
    expect(nameInput().value).toBe('customTemplates.duplicate.defaultName|name=Release Pipeline');

    await duplicateOnce();
    expect(duplicateTemplate).toHaveBeenCalledWith({
      sourceTemplateId: 'tmpl-1',
      name: 'customTemplates.duplicate.defaultName|name=Release Pipeline',
    });
    expect(onDuplicated).toHaveBeenCalledWith(duplicate);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handles an unresolved duplicate without closing or retrying', async () => {
    duplicateTemplate.mockResolvedValue({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-2',
    } satisfies DuplicateCustomTeamTemplateResult);

    await render();
    await duplicateOnce();

    const alert = host.querySelector('[data-testid="duplicate-template-unresolved"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedTitle');
    expect(alert?.textContent).toContain('customTemplates.states.unresolvedMutationBody');

    // Not reported as success, not retried, and not confused with a name clash.
    expect(onDuplicated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(duplicateTemplate).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="duplicate-template-name-conflict"]')).toBeNull();

    // The entered name stays available for recovery.
    expect(nameInput().value).toBe('customTemplates.duplicate.defaultName|name=Release Pipeline');
    expect(nameInput().disabled).toBe(false);
  });

  it('keeps a known name conflict distinct from an unknown outcome', async () => {
    duplicateTemplate.mockResolvedValue({
      status: 'nameConflict',
      existingTemplateId: 'tmpl-9',
    } satisfies DuplicateCustomTeamTemplateResult);

    await render();
    await duplicateOnce();

    expect(host.querySelector('[data-testid="duplicate-template-name-conflict"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="duplicate-template-unresolved"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
