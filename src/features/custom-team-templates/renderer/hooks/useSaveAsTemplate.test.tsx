import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preparePreview = vi.hoisted(() => vi.fn());
const saveTemplate = vi.hoisted(() => vi.fn());
const recheckSave = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  api: { customTeamTemplates: { preparePreview, saveTemplate, recheckSave } },
}));

import { useSaveAsTemplate, type UseSaveAsTemplateResult } from './useSaveAsTemplate';

import type {
  ConfirmCustomTeamTemplateSaveResult,
  CustomTeamTemplatePreview,
  CustomTeamTemplateV1,
  PrepareCustomTeamTemplatePreviewResult,
} from '@features/custom-team-templates/contracts';

const template: CustomTeamTemplateV1 = {
  templateId: 'template-1',
  name: 'Free name',
  schemaVersion: 1,
  teamPrompt: 'Lead the work.',
  members: [{ name: 'ann', role: 'Developer', workflow: 'code' }],
};

function previewWith(token: string, name = 'Alpha'): CustomTeamTemplatePreview {
  return {
    sourceTeamName: 'alpha',
    name,
    teamPrompt: 'Lead the work.',
    members: [{ name: 'ann', role: 'Developer', workflow: 'code' }],
    warnings: [],
    canonicalContent: 'canonical',
    previewToken: token,
  };
}

function ready(token: string, name = 'Alpha'): PrepareCustomTeamTemplatePreviewResult {
  return { status: 'previewReady', preview: previewWith(token, name) };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: UseSaveAsTemplateResult | null = null;

const Harness = (): React.ReactNode => {
  latest = useSaveAsTemplate({ open: true, sourceTeamName: 'alpha', initialName: 'Alpha' });
  return null;
};

async function render(): Promise<void> {
  await act(async () => {
    root.render(<Harness />);
  });
}

async function saveNow(): Promise<void> {
  await act(async () => {
    await latest?.save();
  });
}

async function renameNow(value: string): Promise<void> {
  await act(async () => {
    latest?.setName(value);
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preparePreview.mockReset();
  saveTemplate.mockReset();
  recheckSave.mockReset();
  preparePreview.mockResolvedValue(ready('token-1'));
  saveTemplate.mockResolvedValue({
    status: 'created',
    template,
  } satisfies ConfirmCustomTeamTemplateSaveResult);
  recheckSave.mockResolvedValue({ status: 'saved', template });
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

describe('useSaveAsTemplate name-conflict recovery', () => {
  it('refreshes the preview on rename after a name conflict and saves without a false expiry', async () => {
    await render();
    expect(latest?.preview?.previewToken).toBe('token-1');

    // The user edits the description before saving; no conflict exists yet, so
    // no preview refresh is triggered for the description edit alone.
    await act(async () => {
      latest?.setDescription('Keep me');
    });
    const prepareCallsBeforeSave = preparePreview.mock.calls.length;

    saveTemplate.mockResolvedValueOnce({
      status: 'nameConflict',
      existingTemplateId: 'template-2',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    await saveNow();

    expect(latest?.nameConflict).toBe(true);
    // The reviewed preview is preserved for the retry; the typed fields stay.
    expect(latest?.preview?.previewToken).toBe('token-1');
    expect(latest?.name).toBe('Alpha');
    expect(latest?.description).toBe('Keep me');

    // Renaming after a genuine conflict re-arms the preview through the
    // supported prepare API with the current name and description.
    preparePreview.mockResolvedValue(ready('token-2', 'Free name'));
    await renameNow('Free name');

    expect(preparePreview).toHaveBeenCalledWith({
      sourceTeamName: 'alpha',
      name: 'Free name',
      description: 'Keep me',
    });
    expect(preparePreview.mock.calls.length).toBeGreaterThan(prepareCallsBeforeSave);
    expect(latest?.name).toBe('Free name');
    expect(latest?.description).toBe('Keep me');
    expect(latest?.nameConflict).toBe(false);
    expect(latest?.preview?.previewToken).toBe('token-2');
    expect(latest?.notice).toBeNull();

    // The retry saves against the refreshed token and succeeds without a
    // false preview-expired error or a redundant confirmation.
    saveTemplate.mockResolvedValueOnce({ status: 'created', template });
    await saveNow();

    expect(saveTemplate).toHaveBeenLastCalledWith({
      previewToken: 'token-2',
      name: 'Free name',
      description: 'Keep me',
    });
    expect(latest?.attempt).toEqual({ status: 'saved', template, alreadyPresent: false });
    expect(latest?.notice).toBeNull();
  });

  it('keeps stale-preview protection when the source changes after a name conflict', async () => {
    await render();

    saveTemplate.mockResolvedValueOnce({
      status: 'nameConflict',
      existingTemplateId: 'template-2',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    await saveNow();
    expect(latest?.nameConflict).toBe(true);

    preparePreview.mockResolvedValue(ready('token-2', 'Free name'));
    await renameNow('Free name');
    expect(latest?.preview?.previewToken).toBe('token-2');

    // The authoritative source changed before the retry: the save reports a
    // stale preview, which must require a fresh review instead of reusing the
    // old confirmation.
    saveTemplate.mockResolvedValueOnce({
      status: 'stalePreview',
      sourceTeamName: 'alpha',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    preparePreview.mockResolvedValue(ready('token-3', 'Free name'));
    const savesBefore = saveTemplate.mock.calls.length;
    await saveNow();

    expect(latest?.notice).toBe('stale');
    expect(latest?.attempt).toBeNull();
    expect(latest?.preview?.previewToken).toBe('token-3');
    // No automatic second save: exactly one explicit save was issued.
    expect(saveTemplate.mock.calls.length).toBe(savesBefore + 1);
    expect(latest?.attempt).not.toEqual(expect.objectContaining({ status: 'saved' }));
  });

  it('runs a single save while one is in flight and drops a late prepare response', async () => {
    await render();

    // Duplicate submissions collapse into one in-flight save.
    let resolveSave!: (value: ConfirmCustomTeamTemplateSaveResult) => void;
    saveTemplate.mockReturnValueOnce(
      new Promise<ConfirmCustomTeamTemplateSaveResult>((done) => (resolveSave = done))
    );
    act(() => {
      void latest?.save();
      void latest?.save();
    });
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSave({ status: 'created', template });
    });
    expect(latest?.attempt).toEqual({ status: 'saved', template, alreadyPresent: false });

    // A new conflict arms the rename path again; two rapid renames issue two
    // prepares, and the late (older) response must not overwrite the newer one.
    saveTemplate.mockResolvedValueOnce({
      status: 'nameConflict',
      existingTemplateId: 'template-2',
    } satisfies ConfirmCustomTeamTemplateSaveResult);
    // Fresh preview first so the conflict path has reviewed content.
    preparePreview.mockResolvedValue(ready('token-9'));
    await act(async () => {
      await latest?.refresh();
    });
    await saveNow();
    expect(latest?.nameConflict).toBe(true);

    let resolveFirst!: (value: PrepareCustomTeamTemplatePreviewResult) => void;
    let resolveSecond!: (value: PrepareCustomTeamTemplatePreviewResult) => void;
    preparePreview
      .mockReturnValueOnce(
        new Promise<PrepareCustomTeamTemplatePreviewResult>((done) => (resolveFirst = done))
      )
      .mockReturnValueOnce(
        new Promise<PrepareCustomTeamTemplatePreviewResult>((done) => (resolveSecond = done))
      );
    const prepareCallsBeforeRenames = preparePreview.mock.calls.length;
    act(() => {
      latest?.setName('First rename');
      latest?.setName('Second rename');
    });
    expect(preparePreview.mock.calls.length).toBe(prepareCallsBeforeRenames + 2);
    await act(async () => {
      resolveSecond(ready('token-second', 'Second rename'));
    });
    await act(async () => {
      resolveFirst(ready('token-first', 'First rename'));
    });
    expect(latest?.preview?.previewToken).toBe('token-second');
    expect(latest?.name).toBe('Second rename');
  });
});
