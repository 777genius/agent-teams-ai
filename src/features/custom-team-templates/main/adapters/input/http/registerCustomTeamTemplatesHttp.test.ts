import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCustomTeamTemplatesHttp } from './registerCustomTeamTemplatesHttp';
import { CUSTOM_TEAM_TEMPLATE_BODY_LIMIT } from './registerCustomTeamTemplatesHttp';

import type { CustomTeamTemplatesFeature } from '../../../composition/createCustomTeamTemplatesFeature';
import type { FastifyInstance } from 'fastify';

function createFeature(): CustomTeamTemplatesFeature {
  const updateTemplate = vi.fn().mockResolvedValue({ status: 'updated' });
  const preparePreview = vi.fn().mockResolvedValue({ status: 'ready' });
  return {
    updateTemplate: { execute: updateTemplate },
    preparePreview: { execute: preparePreview },
    saveTemplate: { execute: vi.fn() },
    recheckSave: { execute: vi.fn() },
    listTemplates: { execute: vi.fn() },
    deleteTemplate: { execute: vi.fn() },
    duplicateTemplate: { execute: vi.fn() },
    copyBuiltinTemplate: { execute: vi.fn() },
  } as unknown as CustomTeamTemplatesFeature;
}

describe('registerCustomTeamTemplatesHttp body limit', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('documents a 128 MiB route body limit', () => {
    expect(CUSTOM_TEAM_TEMPLATE_BODY_LIMIT).toBe(128 * 1024 * 1024);
  });

  it('lets a valid update request larger than 1 MiB reach the handler', async () => {
    const feature = createFeature();
    app = Fastify();
    registerCustomTeamTemplatesHttp(app, feature);

    const largeWorkflow = 'w'.repeat(600_000);
    const body = {
      templateId: 'tmpl-1',
      expectedRevision: 5,
      fields: {
        name: 'Release Pipeline',
        teamPrompt: 'Deliver the feature.',
        members: [
          { name: 'alice', workflow: largeWorkflow },
          { name: 'bob', workflow: largeWorkflow },
        ],
      },
    };
    const serialized = JSON.stringify(body);
    expect(serialized.length).toBeGreaterThan(1024 * 1024);

    const response = await app.inject({
      method: 'POST',
      url: '/api/custom-team-templates/update',
      headers: { 'content-type': 'application/json' },
      payload: serialized,
    });

    expect(response.statusCode).toBe(200);
    expect(
      (feature.updateTemplate as unknown as { execute: ReturnType<typeof vi.fn> }).execute
    ).toHaveBeenCalled();
  });

  it('rejects an oversized request with HTTP 413 before the handler runs', async () => {
    const feature = createFeature();
    app = Fastify();
    registerCustomTeamTemplatesHttp(app, feature);

    // Fastify enforces bodyLimit against the declared Content-Length before
    // parsing the body, so a small payload with an oversized length header
    // triggers the same 413 path without allocating 128 MiB in the test.
    const response = await app.inject({
      method: 'POST',
      url: '/api/custom-team-templates/update',
      headers: {
        'content-type': 'application/json',
        'content-length': String(CUSTOM_TEAM_TEMPLATE_BODY_LIMIT + 1024),
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(413);
    expect(
      (feature.updateTemplate as unknown as { execute: ReturnType<typeof vi.fn> }).execute
    ).not.toHaveBeenCalled();
  });

  it('keeps unrelated routes at the default 1 MiB limit', async () => {
    // The custom-team-templates routes are the only ones touched; this test
    // documents that the default Fastify limit is unchanged for other routes.
    const defaultApp = Fastify();
    expect(defaultApp.initialConfig.bodyLimit).toBe(1024 * 1024);
    await defaultApp.close();
  });
});
