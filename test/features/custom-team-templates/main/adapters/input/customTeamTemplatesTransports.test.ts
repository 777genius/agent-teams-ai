import {
  CUSTOM_TEAM_TEMPLATE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_ROUTES,
} from '@features/custom-team-templates/contracts';
import { registerCustomTeamTemplatesHttp } from '@features/custom-team-templates/main/adapters/input/http/registerCustomTeamTemplatesHttp';
import {
  registerCustomTeamTemplatesIpc,
  removeCustomTeamTemplatesIpc,
} from '@features/custom-team-templates/main/adapters/input/ipc/registerCustomTeamTemplatesIpc';
import { createCustomTeamTemplatesFeature } from '@features/custom-team-templates/main/composition/createCustomTeamTemplatesFeature';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';
import type { CustomTeamTemplatesFeature } from '@features/custom-team-templates/main/composition/createCustomTeamTemplatesFeature';
import type { IpcMain } from 'electron';
import type { FastifyInstance } from 'fastify';

const TEAM = 'alpha-team';

const STORED: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  schemaVersion: 1,
  teamPrompt: 'Deliver the feature.',
  members: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

interface FakeIpcMain {
  handle(channel: string, handler: (event: unknown, request?: unknown) => unknown): void;
  removeHandler(channel: string): void;
  invoke(channel: string, request?: unknown): Promise<unknown>;
  channels(): string[];
}

/** Minimal IpcMain stand-in that records handlers exactly like Electron does. */
function fakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>();
  return {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
    invoke: (channel, request) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no IPC handler registered for ${channel}`);
      return Promise.resolve(handler({}, request));
    },
    channels: () => [...handlers.keys()].sort((left, right) => left.localeCompare(right)),
  };
}

interface FakeFastify {
  post(
    path: string,
    optionsOrHandler:
      | { bodyLimit?: number }
      | ((request: { body?: unknown }) => unknown),
    handler?: (request: { body?: unknown }) => unknown
  ): void;
  get(path: string, handler: (request: { body?: unknown }) => unknown): void;
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  keys(): string[];
}

/** Minimal Fastify stand-in that records routes by method and path. */
function fakeFastify(): FakeFastify {
  const routes = new Map<string, (request: { body?: unknown }) => unknown>();
  return {
    post: (path, optionsOrHandler, handler) => {
      const resolvedHandler =
        typeof optionsOrHandler === 'function' ? optionsOrHandler : handler;
      if (!resolvedHandler) throw new Error('missing handler');
      routes.set(`POST ${path}`, resolvedHandler);
    },
    get: (path, handler) => {
      routes.set(`GET ${path}`, handler);
    },
    call: (method, path, body) => {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`no HTTP route registered for ${method} ${path}`);
      return Promise.resolve(handler({ body }));
    },
    keys: () => [...routes.keys()].sort((left, right) => left.localeCompare(right)),
  };
}

function reader() {
  return {
    readSnapshot: (sourceTeamName: string) =>
      sourceTeamName === TEAM
        ? Promise.resolve({
            status: 'available',
            snapshot: {
              sourceTeamName: TEAM,
              teamPrompt: 'Deliver the feature.',
              roster: { status: 'readable', members: [{ name: 'alice' }] } as const,
            },
            revision: 'revision-1',
          } as const)
        : Promise.resolve({ status: 'sourceUnavailable', sourceTeamName } as const),
  };
}

/** A library that already holds one conflicting name and accepts everything else. */
function gateway(): CustomTeamTemplateStorageGateway {
  const rows = new Map<string, CustomTeamTemplateV1>([
    ['tmpl-existing', { ...STORED, templateId: 'tmpl-existing', name: 'Release Pipeline' }],
  ]);
  return {
    customTeamTemplateCreate: (request) => {
      const existing = rows.get(request.template.templateId);
      if (existing) return Promise.resolve({ status: 'alreadySaved', template: existing });
      const template: CustomTeamTemplateV1 = {
        ...request.template,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      rows.set(template.templateId, template);
      return Promise.resolve({ status: 'created', template });
    },
    customTeamTemplateList: () =>
      Promise.resolve({ templates: [...rows.values()], unreadableRecords: [] }),
    customTeamTemplateGetById: ({ templateId }) => {
      const found = rows.get(templateId);
      return Promise.resolve(found ? { status: 'found', template: found } : { status: 'notFound' });
    },
    customTeamTemplateUpdate: vi.fn(),
    customTeamTemplateDelete: vi.fn(),
  };
}

function deterministicFeature(): CustomTeamTemplatesFeature {
  // Both transports get an identically composed feature, and each issues tokens
  // in lockstep, so equal requests produce byte-identical outcomes (including
  // the preview token) and any parity break shows up as a real diff.
  let issued = 0;
  return createCustomTeamTemplatesFeature({
    backend: { gateway: gateway() },
    snapshotReader: reader(),
    now: () => 0,
    createPreviewToken: () => `token-${++issued}`,
  });
}

describe('custom-team-templates transports', () => {
  it('registers exactly the eight IPC channels and the eight HTTP routes', () => {
    const ipc = fakeIpcMain();
    const http = fakeFastify();
    registerCustomTeamTemplatesIpc(ipc as unknown as IpcMain, deterministicFeature());
    registerCustomTeamTemplatesHttp(http as unknown as FastifyInstance, deterministicFeature());

    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect(ipc.channels()).toEqual(Object.values(CUSTOM_TEAM_TEMPLATE_CHANNELS).sort(byName));
    expect(http.keys()).toEqual(
      [
        `POST ${CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview}`,
        `POST ${CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate}`,
        `POST ${CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave}`,
        `GET ${CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates}`,
        `POST ${CUSTOM_TEAM_TEMPLATE_ROUTES.updateTemplate}`,
        `POST ${CUSTOM_TEAM_TEMPLATE_ROUTES.deleteTemplate}`,
        `POST ${CUSTOM_TEAM_TEMPLATE_ROUTES.duplicateTemplate}`,
        `POST ${CUSTOM_TEAM_TEMPLATE_ROUTES.copyBuiltinTemplate}`,
      ].sort(byName)
    );
    // No transport is registered by composition itself.
    const untouched = fakeIpcMain();
    deterministicFeature();
    expect(untouched.channels()).toEqual([]);
  });

  it('forwards the raw payload to the shared use cases without re-implementing them', async () => {
    const ipc = fakeIpcMain();
    const http = fakeFastify();
    const prepare = { execute: vi.fn().mockResolvedValue({ status: 'sourceUnavailable' }) };
    const save = { execute: vi.fn().mockResolvedValue({ status: 'storageUnavailable' }) };
    const recheck = { execute: vi.fn().mockResolvedValue({ status: 'storageUnavailable' }) };
    const list = { execute: vi.fn().mockResolvedValue({ status: 'empty' }) };
    const update = { execute: vi.fn().mockResolvedValue({ status: 'storageUnavailable' }) };
    const remove = { execute: vi.fn().mockResolvedValue({ status: 'storageUnavailable' }) };
    const duplicate = { execute: vi.fn().mockResolvedValue({ status: 'storageUnavailable' }) };
    const copyBuiltin = { execute: vi.fn().mockResolvedValue({ status: 'storageUnavailable' }) };
    const feature = {
      preparePreview: prepare,
      saveTemplate: save,
      recheckSave: recheck,
      listTemplates: list,
      updateTemplate: update,
      deleteTemplate: remove,
      duplicateTemplate: duplicate,
      copyBuiltinTemplate: copyBuiltin,
      dispose: vi.fn(),
    } as unknown as CustomTeamTemplatesFeature;
    registerCustomTeamTemplatesIpc(ipc as unknown as IpcMain, feature);
    registerCustomTeamTemplatesHttp(http as unknown as FastifyInstance, feature);

    // Unknown extra fields survive to the use case, which owns validation. The
    // transport must not prune, reinterpret or type-check them itself.
    const payload = {
      sourceTeamName: TEAM,
      name: 'Release Pipeline',
      templateId: 'tmpl-attacker',
      contentHash: 'sha256:forged',
    };
    await expect(
      ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.preparePreview, payload)
    ).resolves.toEqual({ status: 'sourceUnavailable' });
    await expect(
      http.call('POST', CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview, payload)
    ).resolves.toEqual({ status: 'sourceUnavailable' });
    expect(prepare.execute).toHaveBeenNthCalledWith(1, payload);
    expect(prepare.execute).toHaveBeenNthCalledWith(2, payload);

    await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.saveTemplate, { previewToken: 't' });
    await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.recheckSave, { previewToken: 't' });
    expect(save.execute).toHaveBeenCalledWith({ previewToken: 't' });
    expect(recheck.execute).toHaveBeenCalledWith({ previewToken: 't' });

    // The read-only list takes no request at all.
    await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates);
    await http.call('GET', CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates);
    expect(list.execute).toHaveBeenCalledTimes(2);
  });

  it('produces equivalent domain outcomes over IPC and HTTP for the same requests', async () => {
    const ipc = fakeIpcMain();
    const http = fakeFastify();
    registerCustomTeamTemplatesIpc(ipc as unknown as IpcMain, deterministicFeature());
    registerCustomTeamTemplatesHttp(http as unknown as FastifyInstance, deterministicFeature());

    const cases: readonly [keyof typeof CUSTOM_TEAM_TEMPLATE_CHANNELS, unknown][] = [
      ['preparePreview', { sourceTeamName: TEAM, name: '' }],
      ['preparePreview', { sourceTeamName: '../escape', name: 'Template' }],
      ['preparePreview', { sourceTeamName: TEAM, name: 'release   pipeline' }],
      ['preparePreview', { sourceTeamName: TEAM, name: 'Fresh Template' }],
      ['saveTemplate', { previewToken: 'unknown-token' }],
      ['recheckSave', { previewToken: 'unknown-token' }],
    ];

    for (const [operation, payload] of cases) {
      const overIpc = await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS[operation], payload);
      const overHttp = await http.call('POST', CUSTOM_TEAM_TEMPLATE_ROUTES[operation], payload);
      expect(overHttp).toEqual(overIpc);
    }

    expect(await http.call('GET', CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates)).toEqual(
      await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates)
    );

    // A full confirm-and-re-check flow is also domain-equivalent, including the
    // record a save returns and the outcome a re-check reports.
    const preparedIpc = (await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.preparePreview, {
      sourceTeamName: TEAM,
      name: 'Ship It',
    })) as { status: string; preview: { previewToken: string } };
    const preparedHttp = (await http.call('POST', CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview, {
      sourceTeamName: TEAM,
      name: 'Ship It',
    })) as { status: string; preview: { previewToken: string } };
    expect(preparedIpc.status).toBe('previewReady');
    expect(preparedHttp).toEqual(preparedIpc);

    const token = preparedIpc.preview.previewToken;
    const savedIpc = await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.saveTemplate, {
      previewToken: token,
      name: 'Ship It Renamed',
    });
    const savedHttp = await http.call('POST', CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate, {
      previewToken: token,
      name: 'Ship It Renamed',
    });
    expect(savedHttp).toEqual(savedIpc);
    expect(savedIpc).toMatchObject({ status: 'created' });

    expect(
      await http.call('POST', CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave, { previewToken: token })
    ).toEqual(await ipc.invoke(CUSTOM_TEAM_TEMPLATE_CHANNELS.recheckSave, { previewToken: token }));
  });

  it('removes exactly the registered IPC channels on shutdown', () => {
    const ipc = fakeIpcMain();
    registerCustomTeamTemplatesIpc(ipc as unknown as IpcMain, deterministicFeature());
    expect(ipc.channels()).toHaveLength(8);

    removeCustomTeamTemplatesIpc(ipc as unknown as IpcMain);
    expect(ipc.channels()).toEqual([]);
  });
});
