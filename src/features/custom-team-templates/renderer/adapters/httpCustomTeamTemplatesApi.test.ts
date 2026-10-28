import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOM_TEAM_TEMPLATE_ROUTES } from '../../contracts';

import { createHttpCustomTeamTemplatesApi } from './httpCustomTeamTemplatesApi';

import type { UpdateCustomTeamTemplateResult } from '../../contracts';

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
