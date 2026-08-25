export const forbiddenCoreImportFixtureSource = [
  "import { ipcMain } from 'electron';",
  "import { createLogger } from '@main/logging';",
  'export const fixture = ipcMain && createLogger;',
].join('\n');
