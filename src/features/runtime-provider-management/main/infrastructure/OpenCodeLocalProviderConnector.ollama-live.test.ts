/* eslint-disable sonarjs/no-clear-text-protocols -- live Ollama uses the documented local HTTP API */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  isAppManagedOpenCodeLocalModel,
  shouldRetainOpenCodeLocalCatalogModel,
} from '@renderer/components/team/dialogs/openCodeLocalCatalogVisibility';
import {
  countConfiguredLocalOpenCodeCatalogModels,
  isKnownConfiguredLocalOpenCodeCatalogModel,
} from '@shared/utils/opencodeModelRoute';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenCodeLocalProviderConnector } from './OpenCodeLocalProviderConnector';

const LIVE_ENABLED = process.env.LIVE_OLLAMA === '1';
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
const liveDescribe = LIVE_ENABLED ? describe : describe.skip;

async function generateOnce(modelId: string): Promise<string> {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      prompt: 'Reply with the single word ok.',
      stream: false,
      options: { num_predict: 8, temperature: 0 },
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama generate failed: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as { response?: unknown };
  return typeof payload.response === 'string' ? payload.response : '';
}

liveDescribe('OpenCodeLocalProviderConnector live Ollama', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-ollama-live-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it(
    'probes, configures into a sandbox, and keeps the catalog model after an empty overlay',
    { timeout: 90_000 },
    async () => {
      const homePath = path.join(tempDir, 'home');
      const projectPath = path.join(tempDir, 'sandbox-project');
      await fs.mkdir(projectPath, { recursive: true });
      const connector = new OpenCodeLocalProviderConnector({
        homePath,
        environment: {},
      });

      const probe = await connector.probeLocalProvider({
        runtimeId: 'opencode',
        presetId: 'ollama',
      });
      expect(probe.error).toBeUndefined();
      expect(probe.probe).toMatchObject({
        state: 'available',
        providerId: 'ollama',
        baseUrl: OLLAMA_BASE_URL,
      });
      const liveModelId = probe.probe?.models[0]?.id;
      if (!liveModelId) {
        throw new Error('Live Ollama probe did not return a model id.');
      }

      const generated = await generateOnce(liveModelId);
      expect(generated.trim().length).toBeGreaterThan(0);

      const configured = await connector.configureLocalProvider({
        runtimeId: 'opencode',
        scope: 'project',
        projectPath,
        presetId: 'ollama',
        defaultModelId: liveModelId,
        setAsDefault: true,
      });
      expect(configured.error).toBeUndefined();
      expect(configured.configuration).toMatchObject({
        providerId: 'ollama',
        defaultModelId: liveModelId,
        modelRoute: `ollama/${liveModelId}`,
        scope: 'project',
        setAsDefault: true,
      });

      const listed = await connector.listLocalProviders({
        runtimeId: 'opencode',
        scope: 'project',
        projectPath,
      });
      expect(listed.error).toBeUndefined();
      expect(listed.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: 'ollama',
            state: 'available',
            defaultModelId: liveModelId,
          }),
        ])
      );

      const catalogModel = {
        id: `ollama/${liveModelId}`,
        launchModel: `ollama/${liveModelId}`,
        metadata: {
          opencode: {
            providerId: 'ollama',
            routeKind: 'configured_local' as const,
            accessKind: 'configured_authless' as const,
          },
        },
      };
      const emptyOverlay = new Set<string>();
      const v2141KeptCatalogLocal =
        emptyOverlay.has(catalogModel.id) ||
        !isAppManagedOpenCodeLocalModel(catalogModel.id, catalogModel);

      expect(countConfiguredLocalOpenCodeCatalogModels([catalogModel])).toBe(1);
      expect(isKnownConfiguredLocalOpenCodeCatalogModel(catalogModel.id, catalogModel)).toBe(true);
      expect(v2141KeptCatalogLocal).toBe(false);
      expect(
        shouldRetainOpenCodeLocalCatalogModel(catalogModel.id, catalogModel, emptyOverlay)
      ).toBe(true);
    }
  );
});
/* eslint-enable sonarjs/no-clear-text-protocols -- re-enable after the live Ollama HTTP calls */
