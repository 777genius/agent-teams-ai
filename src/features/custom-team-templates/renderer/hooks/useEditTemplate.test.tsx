import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateTemplate = vi.hoisted(() => vi.fn());
const listTemplates = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  api: { customTeamTemplates: { updateTemplate, listTemplates } },
}));

import { useEditTemplate, type UseEditTemplateResult } from './useEditTemplate';

import type {
  CustomTeamTemplateV1,
  ListCustomTeamTemplatesResult,
  UpdateCustomTeamTemplateResult,
} from '@features/custom-team-templates/contracts';

const template: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  description: 'Ship it.',
  schemaVersion: 1,
  teamPrompt: 'Deliver the feature.',
  members: [{ name: 'alice', role: 'reviewer' }],
  revision: 5,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: UseEditTemplateResult | null = null;
let open = true;
let selected: CustomTeamTemplateV1 | null = template;
let onSaved: ReturnType<typeof vi.fn>;

const Harness = (): React.ReactNode => {
  latest = useEditTemplate({ open, template: selected, onSaved });
  return null;
};

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Harness />);
  });
}

async function saveNow(): Promise<boolean> {
  let result = false;
  await act(async () => {
    result = (await latest?.save()) ?? false;
  });
  return result;
}

async function recheckNow(): Promise<boolean> {
  let result = false;
  await act(async () => {
    result = (await latest?.recheck()) ?? false;
  });
  return result;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  updateTemplate.mockReset();
  listTemplates.mockReset();
  onSaved = vi.fn();
  open = true;
  selected = template;
  latest = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('useEditTemplate unresolved writes', () => {
  it('keeps a dispatched update with an aborted transport unresolved and preserves the draft', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();

    await act(async () => {
      latest?.setName('Draft name');
      latest?.setDescription('Draft description');
      latest?.setTeamPrompt('Draft prompt.');
      latest?.addMember({ name: 'bob', role: 'writer' });
    });

    await expect(saveNow()).resolves.toBe(false);

    expect(updateTemplate).toHaveBeenCalledWith({
      templateId: 'tmpl-1',
      expectedRevision: 5,
      fields: {
        name: 'Draft name',
        description: 'Draft description',
        teamPrompt: 'Draft prompt.',
        members: [
          { name: 'alice', role: 'reviewer' },
          { name: 'bob', role: 'writer' },
        ],
      },
    });
    expect(latest?.status).toBe('unresolvedWriteOutcome');
    expect(latest?.busy).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    expect(latest?.expectedRevision).toBe(5);
    expect(latest?.name).toBe('Draft name');
    expect(latest?.description).toBe('Draft description');
    expect(latest?.teamPrompt).toBe('Draft prompt.');
    expect(latest?.members).toEqual([
      { name: 'alice', role: 'reviewer' },
      { name: 'bob', role: 'writer', workflow: '' },
    ]);

    // The stale revision is never resent automatically or by another click.
    expect(latest?.canSave).toBe(false);
    await expect(saveNow()).resolves.toBe(false);
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    expect(latest?.expectedRevision).toBe(5);
  });

  it('keeps definitive revision conflicts on their existing result branch', async () => {
    const current: CustomTeamTemplateV1 = { ...template, revision: 7, name: 'Current name' };
    updateTemplate.mockResolvedValue({
      status: 'revisionConflict',
      current,
    } satisfies UpdateCustomTeamTemplateResult);
    await render();

    await expect(saveNow()).resolves.toBe(false);

    expect(latest?.status).toBe('revisionConflict');
    expect(latest?.revisionConflict).toEqual(current);
    expect(latest?.expectedRevision).toBe(5);
    expect(onSaved).not.toHaveBeenCalled();
    expect(latest?.canRecheck).toBe(false);
  });

  it('treats an HTTP 413 as a known pre-dispatch rejection', async () => {
    updateTemplate.mockRejectedValue(new Error('custom team templates request failed: HTTP 413'));
    await render();
    await act(async () => {
      latest?.updateMember(0, { name: 'alice' });
    });

    await expect(saveNow()).resolves.toBe(false);

    expect(latest?.status).toBe('requestSizeValidationFailed');
    expect(latest?.busy).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    expect(latest?.expectedRevision).toBe(5);
    expect(latest?.canRecheck).toBe(false);
    expect(latest?.name).toBe('Release Pipeline');
    expect(latest?.canSave).toBe(true);
  });

  it('keeps a genuine dispatched timeout as an unresolved write outcome', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();

    await expect(saveNow()).resolves.toBe(false);

    expect(latest?.status).toBe('unresolvedWriteOutcome');
    expect(latest?.canRecheck).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not treat an exception from onSaved as a transport failure', async () => {
    updateTemplate.mockResolvedValue({
      status: 'updated',
      template: { ...template, revision: 6 },
    } satisfies UpdateCustomTeamTemplateResult);
    onSaved.mockImplementation(() => {
      throw new Error('renderer callback failed');
    });
    await render();

    await act(async () => {
      await expect(latest?.save()).rejects.toThrow('renderer callback failed');
    });

    expect(latest?.status).toBe('saved');
    expect(latest?.expectedRevision).toBe(6);
  });

  it('confirms a re-check only for the exact next revision and intended content', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();
    await act(async () => {
      latest?.setName('Recovered name');
    });
    await saveNow();
    expect(latest?.canRecheck).toBe(true);

    // The old revision does not prove non-commit while the server may still be
    // running the update.
    listTemplates.mockResolvedValue({
      status: 'ready',
      templates: [template],
    } satisfies ListCustomTeamTemplatesResult);
    await expect(recheckNow()).resolves.toBe(false);
    expect(latest?.status).toBe('unresolvedWriteOutcome');
    expect(onSaved).not.toHaveBeenCalled();

    // A different record at the next revision is not proof either.
    listTemplates.mockResolvedValue({
      status: 'ready',
      templates: [{ ...template, name: 'Someone else', revision: 6 }],
    } satisfies ListCustomTeamTemplatesResult);
    await expect(recheckNow()).resolves.toBe(false);
    expect(latest?.status).toBe('unresolvedWriteOutcome');
    expect(onSaved).not.toHaveBeenCalled();

    const stored: CustomTeamTemplateV1 = {
      ...template,
      name: 'Recovered name',
      revision: 6,
    };
    listTemplates.mockResolvedValue({
      status: 'ready',
      templates: [stored],
    } satisfies ListCustomTeamTemplatesResult);
    await expect(recheckNow()).resolves.toBe(true);
    expect(latest?.status).toBe('saved');
    expect(latest?.expectedRevision).toBe(6);
    expect(onSaved).toHaveBeenCalledWith(stored);
  });

  it('rejects a re-check when content differs at the exact next revision', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();
    await act(async () => {
      latest?.setName('Recovered name');
    });
    await saveNow();
    expect(latest?.canRecheck).toBe(true);

    // Same name and next revision, but a different team prompt does not prove
    // the intended update committed.
    listTemplates.mockResolvedValue({
      status: 'ready',
      templates: [
        { ...template, name: 'Recovered name', teamPrompt: 'Changed prompt.', revision: 6 },
      ],
    } satisfies ListCustomTeamTemplatesResult);
    await expect(recheckNow()).resolves.toBe(false);
    expect(latest?.status).toBe('unresolvedWriteOutcome');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rejects a re-check when members differ at the exact next revision', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();
    await act(async () => {
      latest?.setName('Recovered name');
    });
    await saveNow();
    expect(latest?.canRecheck).toBe(true);

    // Same name and next revision, but different members does not prove the
    // intended update committed.
    listTemplates.mockResolvedValue({
      status: 'ready',
      templates: [
        {
          ...template,
          name: 'Recovered name',
          members: [{ name: 'bob', role: 'writer' }],
          revision: 6,
        },
      ],
    } satisfies ListCustomTeamTemplatesResult);
    await expect(recheckNow()).resolves.toBe(false);
    expect(latest?.status).toBe('unresolvedWriteOutcome');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rejects a re-check when the matching content is at a later revision', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();
    await act(async () => {
      latest?.setName('Recovered name');
    });
    await saveNow();
    expect(latest?.canRecheck).toBe(true);

    // Matching content at revision 7 rather than the exact next revision 6
    // suggests another writer committed first; the outcome stays unresolved.
    listTemplates.mockResolvedValue({
      status: 'ready',
      templates: [{ ...template, name: 'Recovered name', revision: 7 }],
    } satisfies ListCustomTeamTemplatesResult);
    await expect(recheckNow()).resolves.toBe(false);
    expect(latest?.status).toBe('unresolvedWriteOutcome');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('trims member names so a padded draft reconciles with the stored row', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();
    await act(async () => {
      latest?.updateMember(0, { name: '  alice  ' });
    });

    await expect(saveNow()).resolves.toBe(false);

    // The dispatched payload carries the same normalized name the update use
    // case hashes and persists, so a committed row can be recognised.
    expect(updateTemplate).toHaveBeenCalledWith({
      templateId: 'tmpl-1',
      expectedRevision: 5,
      fields: {
        name: 'Release Pipeline',
        description: 'Ship it.',
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'reviewer' }],
      },
    });
    expect(latest?.status).toBe('unresolvedWriteOutcome');

    // The server stored the trimmed name; the re-check must still match it.
    const stored: CustomTeamTemplateV1 = { ...template, revision: 6 };
    listTemplates.mockResolvedValue({
      status: 'ready',
      templates: [stored],
    } satisfies ListCustomTeamTemplatesResult);

    await expect(recheckNow()).resolves.toBe(true);
    expect(latest?.status).toBe('saved');
    expect(latest?.expectedRevision).toBe(6);
    expect(onSaved).toHaveBeenCalledWith(stored);
  });

  it('drops a stale save result after the dialog closes and reopens', async () => {
    const pending = deferred<UpdateCustomTeamTemplateResult>();
    updateTemplate.mockReturnValue(pending.promise);
    await render();

    let savePromise: Promise<boolean> | undefined;
    await act(async () => {
      savePromise = latest?.save();
    });
    expect(updateTemplate).toHaveBeenCalledTimes(1);

    open = false;
    selected = null;
    await render();
    open = true;
    selected = template;
    await render();

    await act(async () => {
      pending.resolve({ status: 'updated', template: { ...template, revision: 6 } });
      await savePromise;
    });

    expect(latest?.status).toBe('idle');
    expect(latest?.expectedRevision).toBe(5);
    expect(latest?.busy).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('drops a stale re-check result after the dialog closes', async () => {
    updateTemplate.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await render();
    await saveNow();

    const pending = deferred<ListCustomTeamTemplatesResult>();
    listTemplates.mockReturnValue(pending.promise);
    let recheckPromise: Promise<boolean> | undefined;
    await act(async () => {
      recheckPromise = latest?.recheck();
    });

    open = false;
    selected = null;
    await render();
    open = true;
    selected = template;
    await render();

    await act(async () => {
      pending.resolve({
        status: 'ready',
        templates: [{ ...template, revision: 6 }],
      });
      await recheckPromise;
    });

    expect(latest?.status).toBe('idle');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
