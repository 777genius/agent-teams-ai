import { registerTeamRoutes } from '@main/http/teams';
import { bindTeamHttpDataApi } from '@main/services/team/contracts/TeamProvisioningApis';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import Fastify from 'fastify';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { HttpServices } from '@main/http';

const tempPaths: string[] = [];

async function createBoundary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'http-draft-provenance-'));
  tempPaths.push(root);
  setClaudeBasePathOverride(root);
  const service = new TeamDataService();
  const app = Fastify();
  registerTeamRoutes(app, {
    teamDataApi: bindTeamHttpDataApi(service),
  } as unknown as HttpServices);
  await app.ready();
  return { app, root, service };
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(
    tempPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true }))
  );
});

describe('POST /api/teams draft provenance boundary', () => {
  it('materializes missing provenance from explicit HTTP field intent', async () => {
    const { app, service } = await createBoundary();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams',
        payload: {
          teamName: 'http-explicit',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          members: [
            {
              name: 'builder',
              providerBackendId: 'codex-native',
              model: 'gpt-5.4',
              effort: 'high',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      await expect(service.getSavedRequest('http-explicit')).resolves.toMatchObject({
        leadRuntimeSelectionProvenance: {
          providerBackendId: 'explicit',
          model: 'explicit',
          effort: 'explicit',
        },
        members: [
          {
            runtimeSelectionProvenance: {
              providerBackendId: 'explicit',
              model: 'explicit',
              effort: 'explicit',
            },
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('keeps normalized concrete defaults labeled default and inherited', async () => {
    const { app, service } = await createBoundary();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams',
        payload: {
          teamName: 'http-defaults',
          providerId: 'codex',
          members: [{ name: 'builder' }],
        },
      });

      expect(response.statusCode).toBe(201);
      await expect(service.getSavedRequest('http-defaults')).resolves.toMatchObject({
        providerBackendId: 'codex-native',
        leadRuntimeSelectionProvenance: {
          providerBackendId: 'default',
          model: 'default',
          effort: 'default',
        },
        members: [
          {
            runtimeSelectionProvenance: {
              providerBackendId: 'inherited',
              model: 'inherited',
              effort: 'inherited',
            },
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('preserves supplied default and inherited provenance', async () => {
    const { app, service } = await createBoundary();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams',
        payload: {
          teamName: 'http-supplied',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'default',
            model: 'default',
            effort: 'default',
          },
          members: [
            {
              name: 'builder',
              providerBackendId: 'codex-native',
              model: 'gpt-5.4',
              effort: 'high',
              runtimeSelectionProvenance: {
                version: 1,
                providerBackendId: 'inherited',
                model: 'inherited',
                effort: 'inherited',
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      await expect(service.getSavedRequest('http-supplied')).resolves.toMatchObject({
        leadRuntimeSelectionProvenance: {
          providerBackendId: 'default',
          model: 'default',
          effort: 'default',
        },
        members: [
          {
            runtimeSelectionProvenance: {
              providerBackendId: 'inherited',
              model: 'inherited',
              effort: 'inherited',
            },
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      label: 'invalid lead provenance',
      payload: { leadRuntimeSelectionProvenance: { version: 1, model: 'explicit' } },
    },
    {
      label: 'unresolved member provenance',
      payload: {
        members: [
          {
            name: 'builder',
            runtimeSelectionProvenance: {
              version: 1,
              providerBackendId: 'unknown',
              model: 'unknown',
              effort: 'unknown',
              unknownReason: 'absent',
            },
          },
        ],
      },
    },
  ])('rejects $label before strict service admission', async ({ payload }) => {
    const { app, root } = await createBoundary();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams',
        payload: { teamName: 'http-rejected', members: [], ...payload },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('provenance');
      await expect(fs.access(path.join(root, 'teams', 'http-rejected'))).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});
