import {
  CUSTOM_TEAM_TEMPLATE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS,
} from '@features/custom-team-templates/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcRenderer: { invoke },
}));

import { createCustomTeamTemplatesBridge } from '@features/custom-team-templates/preload';

describe('createCustomTeamTemplatesBridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ status: 'cancelled' });
  });

  it('forwards every shared data operation to its own channel', async () => {
    const bridge = createCustomTeamTemplatesBridge();

    await bridge.preparePreview({ sourceTeamName: 'team' } as never);
    await bridge.saveTemplate({ previewToken: 'token' } as never);
    await bridge.recheckSave({ recheckToken: 'token' } as never);
    await bridge.listTemplates();
    await bridge.updateTemplate({ templateId: 'tmpl-1' } as never);
    await bridge.deleteTemplate({ templateId: 'tmpl-1' } as never);
    await bridge.duplicateTemplate({ templateId: 'tmpl-1' } as never);
    await bridge.copyBuiltinTemplate({ builtinTemplateId: 'builtin' } as never);
    await bridge.exportTemplate({ templateId: 'tmpl-1' });
    await bridge.importTemplate({ portable: {} } as never);

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      CUSTOM_TEAM_TEMPLATE_CHANNELS.preparePreview,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.saveTemplate,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.recheckSave,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.updateTemplate,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.deleteTemplate,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.duplicateTemplate,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.copyBuiltinTemplate,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.exportTemplate,
      CUSTOM_TEAM_TEMPLATE_CHANNELS.importTemplate,
    ]);
  });

  it('exposes desktop file operations on their dedicated channels', async () => {
    const bridge = createCustomTeamTemplatesBridge();

    await bridge.desktopFile?.importFromFile();
    await bridge.desktopFile?.exportToFile({ templateId: 'tmpl-1' });

    expect(invoke).toHaveBeenNthCalledWith(1, CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.importFromFile);
    expect(invoke).toHaveBeenNthCalledWith(2, CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.exportToFile, {
      templateId: 'tmpl-1',
    });
    // The import call receives no payload at all: a renderer cannot name a path.
    expect(invoke.mock.calls[0]).toHaveLength(1);
  });

  it('returns the typed outcome unchanged', async () => {
    const outcome = {
      status: 'nameConflict',
      existingTemplateId: 'tmpl-existing',
      portable: { name: 'Taken' },
    };
    invoke.mockResolvedValue(outcome);
    const bridge = createCustomTeamTemplatesBridge();

    await expect(bridge.importTemplate({ portable: {} } as never)).resolves.toBe(outcome);
  });
});
