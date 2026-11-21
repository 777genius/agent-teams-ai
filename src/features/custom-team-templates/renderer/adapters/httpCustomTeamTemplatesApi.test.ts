import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOM_TEAM_TEMPLATE_ROUTES } from '../../contracts';

import { createHttpCustomTeamTemplatesApi } from './httpCustomTeamTemplatesApi';

import type {
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
  UpdateCustomTeamTemplateResult,
} from '../../contracts';

const request = {
  templateId: 'tmpl-1',
  expectedRevision: 5,
  fields: {
    name: 'Release Pipeline',
    teamPrompt: 'Deliver the feature.',
    members: [{ name: 'alice' }],
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createHttpCustomTeamTemplatesApi update transport', () => {
  it('aborts a dispatched update after the configured timeout and rejects', async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = createHttpCustomTeamTemplatesApi('http://127.0.0.1:4321');
    const settled = api.updateTemplate(request).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await settled;

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4321${CUSTOM_TEAM_TEMPLATE_ROUTES.updateTemplate}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(request),
      })
    );
  });

  it('returns a definitive typed outcome when the response arrives', async () => {
    const outcome: UpdateCustomTeamTemplateResult = {
      status: 'updated',
      template: {
        templateId: 'tmpl-1',
        name: 'Release Pipeline',
        schemaVersion: 1,
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice' }],
        revision: 6,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(outcome),
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = createHttpCustomTeamTemplatesApi('http://127.0.0.1:4321');
    await expect(api.updateTemplate(request)).resolves.toEqual(outcome);
  });

  it('rejects a non-2xx response instead of inventing a domain outcome', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = createHttpCustomTeamTemplatesApi('http://127.0.0.1:4321');
    await expect(api.updateTemplate(request)).rejects.toThrow(
      'custom team templates request failed: HTTP 503'
    );
  });
});

describe('createHttpCustomTeamTemplatesApi browser file import', () => {
  const portable: PortableCustomTeamTemplateV1 = {
    format: 'agent-teams-custom-template',
    schemaVersion: 1,
    name: 'Release Pipeline',
    teamPrompt: 'Plan\nShip',
    members: [{ name: 'engineer', workflow: 'Build\nTest' }],
  };

  it('sends the parsed file once and preserves the confirmed import result', async () => {
    const outcome: ImportCustomTeamTemplateResult = {
      status: 'imported',
      template: {
        templateId: 'tmpl-imported',
        schemaVersion: 1,
        name: portable.name,
        teamPrompt: portable.teamPrompt,
        members: portable.members,
        revision: 1,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(outcome),
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpCustomTeamTemplatesApi('http://127.0.0.1:4321');
    const file = new File([JSON.stringify(portable)], 'template.json');

    await expect(api.browserFile!.importFromFile(file)).resolves.toEqual(outcome);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4321${CUSTOM_TEAM_TEMPLATE_ROUTES.importTemplate}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ portable }),
      })
    );
  });

  it.each(['top-level array', 'nested property'])(
    'rejects an unserializable %s before dispatch without claiming a possible write',
    async (shape) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const api = createHttpCustomTeamTemplatesApi('http://127.0.0.1:4321');
      const deepJson = `${'['.repeat(20_000)}0${']'.repeat(20_000)}`;
      const contents = shape === 'top-level array' ? deepJson : `{"format":${deepJson}}`;
      const file = new File([contents], 'deep.json');

      await expect(api.browserFile!.importFromFile(file)).resolves.toEqual({
        status: 'unsupportedFormat',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('keeps a rejected dispatched import unresolved', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('response lost after dispatch'));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpCustomTeamTemplatesApi('http://127.0.0.1:4321');
    const file = new File([JSON.stringify(portable)], 'template.json');

    await expect(api.browserFile!.importFromFile(file)).resolves.toEqual({
      status: 'unresolvedWriteOutcome',
      templateId: '',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['import', 'export'] as const)(
    'allows a slow %s transfer while retaining a bounded timeout',
    async (operation) => {
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const api = createHttpCustomTeamTemplatesApi('http://127.0.0.1:4321');
      const pending =
        operation === 'import'
          ? api.importTemplate({ portable })
          : api.exportTemplate({ templateId: 'tmpl-1' });
      const settled = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(110_000);
      expect(await settled).toBeInstanceOf(DOMException);
      expect(signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
