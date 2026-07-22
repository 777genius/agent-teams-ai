import * as fs from 'fs';

import { atomicWriteAsync } from '../atomicWrite';

import {
  addPermissionRulesToSettings,
  type ClaudePermissionSettingsFilePorts,
  type ClaudePermissionSettingsLoggerPort,
  seedLeadBootstrapPermissionRules,
} from './TeamProvisioningClaudePermissionSettings';

export interface TeamProvisioningClaudePermissionSettingsDelegation {
  addPermissionRulesToSettings(
    settingsPath: string,
    toolNames: string[],
    behavior: string
  ): Promise<number>;
  seedLeadBootstrapPermissionRules(teamName: string, projectCwd: string): Promise<void>;
}

export function createNodeClaudePermissionSettingsFilePorts(): ClaudePermissionSettingsFilePorts {
  return {
    mkdirRecursive: async (directoryPath) => {
      await fs.promises.mkdir(directoryPath, { recursive: true });
    },
    readFileUtf8: (filePath) => fs.promises.readFile(filePath, 'utf-8'),
    writeFileUtf8: (filePath, contents) => atomicWriteAsync(filePath, contents),
  };
}

export function createTeamProvisioningClaudePermissionSettingsDelegation(input: {
  bootstrapToolNames: readonly string[];
  filePorts?: ClaudePermissionSettingsFilePorts;
  logger: ClaudePermissionSettingsLoggerPort;
}): TeamProvisioningClaudePermissionSettingsDelegation {
  const filePorts = input.filePorts ?? createNodeClaudePermissionSettingsFilePorts();

  return {
    addPermissionRulesToSettings(settingsPath, toolNames, behavior) {
      return addPermissionRulesToSettings({ settingsPath, toolNames, behavior }, filePorts);
    },
    seedLeadBootstrapPermissionRules(teamName, projectCwd) {
      return seedLeadBootstrapPermissionRules(
        {
          teamName,
          projectCwd,
          bootstrapToolNames: input.bootstrapToolNames,
        },
        { ...filePorts, logger: input.logger }
      );
    },
  };
}
