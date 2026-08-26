import { TeamDataService } from '@main/services/team/TeamDataService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { createTeamDraftPayload } from '@renderer/components/team/dialogs/createTeamDraftPayload';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TeamCreateRequest } from '@shared/types';

const tempPaths: string[] = [];

async function createTempService(): Promise<TeamDataService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'renderer-draft-provenance-'));
  tempPaths.push(root);
  setClaudeBasePathOverride(root);
  return new TeamDataService();
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(
    tempPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true }))
  );
});

describe('CreateTeamDialog draft payload boundary', () => {
  it.each([
    {
      label: 'explicit selections',
      request: {
        teamName: 'renderer-explicit',
        cwd: '/tmp/sandbox-project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'high',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'explicit',
          model: 'explicit',
          effort: 'explicit',
        },
        members: [
          {
            name: 'builder',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4',
            effort: 'high',
            runtimeSelectionProvenance: {
              version: 1,
              providerBackendId: 'explicit',
              model: 'explicit',
              effort: 'explicit',
            },
          },
        ],
      },
    },
    {
      label: 'default and inherited selections',
      request: {
        teamName: 'renderer-defaults',
        cwd: '/tmp/sandbox-project',
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
    },
  ] as const)(
    'persists $label through the renderer adapter and strict service',
    async ({ request }) => {
      const service = await createTempService();
      await service.createTeamConfig(
        createTeamDraftPayload(request as unknown as TeamCreateRequest, request.cwd)
      );

      await expect(service.getSavedRequest(request.teamName)).resolves.toMatchObject({
        leadRuntimeSelectionProvenance: request.leadRuntimeSelectionProvenance,
        members: [
          {
            runtimeSelectionProvenance: request.members[0].runtimeSelectionProvenance,
          },
        ],
      });
    }
  );

  it.each([
    { label: 'missing', provenance: undefined },
    { label: 'invalid', provenance: { version: 1, model: 'explicit' } },
  ])('does not fake-resolve $label renderer provenance', async ({ provenance }) => {
    const service = await createTempService();
    const request = {
      teamName: 'renderer-rejected',
      cwd: '/tmp/sandbox-project',
      members: [
        {
          name: 'builder',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'inherited',
          },
        },
      ],
      leadRuntimeSelectionProvenance: provenance,
    } as unknown as TeamCreateRequest;

    await expect(
      service.createTeamConfig(createTeamDraftPayload(request, request.cwd))
    ).rejects.toThrow('provenance is required and must be resolved');
  });
});
