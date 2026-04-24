import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { TeamAttachmentStore } from '../../../src/main/services/team/TeamAttachmentStore';
import { TeamTaskAttachmentStore } from '../../../src/main/services/team/TeamTaskAttachmentStore';
import {
  getAppDataPath,
  getBackupsBasePath,
  getMcpConfigsBasePath,
  getMcpServerBasePath,
  setAppDataBasePath,
} from '../../../src/main/utils/pathDecoder';
import {
  getLegacyElectronUserDataCandidates,
  migrateElectronUserDataDirectory,
  type ElectronUserDataMigrationApp,
} from '../../../src/main/utils/electronUserDataMigration';

class FakeElectronApp implements ElectronUserDataMigrationApp {
  setPathCalls: Array<{ name: string; value: string }> = [];

  constructor(private userDataPath: string) {}

  getPath(name: string): string {
    if (name !== 'userData' && name !== 'sessionData') {
      throw new Error(`Unexpected path lookup: ${name}`);
    }
    return this.userDataPath;
  }

  setPath(name: string, value: string): void {
    this.setPathCalls.push({ name, value });
    if (name === 'userData' || name === 'sessionData') {
      this.userDataPath = value;
    }
  }
}

describe('electron userData migration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setAppDataBasePath(null);
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  function createTempRoot(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-user-data-migration-'));
    tempDirs.push(tempRoot);
    return tempRoot;
  }

  function writeFile(root: string, relativePath: string, content: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  function readFile(root: string, relativePath: string): string {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
  }

  it('derives legacy candidates beside the current Electron userData directory', () => {
    expect(
      getLegacyElectronUserDataCandidates('/Users/me/Library/Application Support/Agent Teams UI')
    ).toEqual([
      '/Users/me/Library/Application Support/Claude Agent Teams UI',
      '/Users/me/Library/Application Support/claude-agent-teams-ui',
      '/Users/me/Library/Application Support/claude-devtools',
      '/Users/me/Library/Application Support/claude-code-context',
    ]);
  });

  it('copies the complete legacy userData tree, including all current app-owned stores', async () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'Claude Agent Teams UI');
    const currentPath = path.join(root, 'Agent Teams UI');
    fs.mkdirSync(currentPath, { recursive: true });

    const knownFiles = [
      [
        'data/attachments/team-a/msg-1/_index.json',
        '[{"id":"att-1","filename":"note.txt","mimeType":"text/plain"}]',
      ],
      ['data/attachments/team-a/msg-1/att-1--note.txt', 'message attachment'],
      ['data/task-attachments/team-a/task-1/task-att-1--task.txt', 'task attachment'],
      ['backups/registry.json', '{"version":1,"teams":{}}'],
      ['backups/teams/team-a/manifest.json', '{"version":1}'],
      ['mcp-configs/agent-teams-mcp-old.json', '{"mcpServers":{}}'],
      ['mcp-server/1.3.0/index.js', 'console.log("mcp")'],
      ['mcp-server/1.3.0/package.json', '{"type":"module"}'],
      ['opencode-bridge/command-ledger.json', '{"commands":[]}'],
      ['opencode-bridge/command-leases.json', '{"leases":[]}'],
      ['logs/claude-cli-auth-diag.ndjson', '{"event":"auth"}\n'],
      ['Local Storage/leveldb/000003.log', 'renderer localStorage bytes'],
      ['future-feature/state.json', '{"kept":true}'],
    ] as const;

    for (const [relativePath, content] of knownFiles) {
      writeFile(legacyPath, relativePath, content);
    }

    const result = migrateElectronUserDataDirectory(new FakeElectronApp(currentPath));

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: true,
      fallbackToLegacy: false,
      reason: 'migrated',
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
    for (const [relativePath, content] of knownFiles) {
      expect(readFile(currentPath, relativePath)).toBe(content);
    }

    setAppDataBasePath(currentPath);
    expect(getAppDataPath()).toBe(path.join(currentPath, 'data'));
    expect(getBackupsBasePath()).toBe(path.join(currentPath, 'backups'));
    expect(getMcpConfigsBasePath()).toBe(path.join(currentPath, 'mcp-configs'));
    expect(getMcpServerBasePath()).toBe(path.join(currentPath, 'mcp-server'));

    const messageAttachments = await new TeamAttachmentStore().getAttachments('team-a', 'msg-1');
    expect(messageAttachments).toEqual([
      {
        id: 'att-1',
        data: Buffer.from('message attachment').toString('base64'),
        mimeType: 'text/plain',
      },
    ]);

    await expect(
      new TeamTaskAttachmentStore().getAttachment('team-a', 'task-1', 'task-att-1', 'text')
    ).resolves.toBe(Buffer.from('task attachment').toString('base64'));
  });

  it('does not merge legacy data into an already populated new userData directory', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'Claude Agent Teams UI');
    const currentPath = path.join(root, 'Agent Teams UI');

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');
    writeFile(currentPath, 'data/attachments/team-a/current.txt', 'current');

    const result = migrateElectronUserDataDirectory(new FakeElectronApp(currentPath));

    expect(result).toMatchObject({
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-populated',
    });
    expect(readFile(currentPath, 'data/attachments/team-a/current.txt')).toBe('current');
    expect(fs.existsSync(path.join(currentPath, 'data/attachments/team-a/legacy.txt'))).toBe(false);
  });

  it('falls back to the legacy userData path for this run when copying fails', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'Claude Agent Teams UI');
    const currentPath = path.join(root, 'Agent Teams UI');
    const app = new FakeElectronApp(currentPath);

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');
    const result = migrateElectronUserDataDirectory(app, {
      copyDirectory: () => {
        throw new Error('copy denied');
      },
    });

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: true,
      reason: 'legacy-fallback',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
  });

  it('uses the new populated userData path if another startup finishes migration first', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'Claude Agent Teams UI');
    const currentPath = path.join(root, 'Agent Teams UI');
    const app = new FakeElectronApp(currentPath);

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app, {
      copyDirectory: () => {
        writeFile(currentPath, 'data/attachments/team-a/current.txt', 'current');
        throw new Error('destination appeared');
      },
    });

    expect(result).toMatchObject({
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-populated',
    });
    expect(app.setPathCalls).toEqual([]);
    expect(readFile(currentPath, 'data/attachments/team-a/current.txt')).toBe('current');
  });

  it('falls back to the legacy userData path when copying fails and new userData is still empty', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'Claude Agent Teams UI');
    const currentPath = path.join(root, 'Agent Teams UI');
    const app = new FakeElectronApp(currentPath);

    fs.mkdirSync(currentPath, { recursive: true });
    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app, {
      copyDirectory: () => {
        throw new Error('copy denied');
      },
    });

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: true,
      reason: 'legacy-fallback',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
  });

  it('does not fallback when the new userData path is a file', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'Claude Agent Teams UI');
    const currentPath = path.join(root, 'Agent Teams UI');

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');
    fs.writeFileSync(currentPath, 'not a directory', 'utf8');

    const result = migrateElectronUserDataDirectory(new FakeElectronApp(currentPath));

    expect(result).toMatchObject({
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-path-exists',
    });
  });

  it('uses the lowercase package-name legacy directory when product-name legacy data is absent', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'Agent Teams UI');

    writeFile(legacyPath, 'mcp-configs/legacy.json', '{}');

    const result = migrateElectronUserDataDirectory(new FakeElectronApp(currentPath));

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: true,
      fallbackToLegacy: false,
      reason: 'migrated',
    });
    expect(readFile(currentPath, 'mcp-configs/legacy.json')).toBe('{}');
  });

  it('prefers populated older legacy data over an empty newer legacy directory', () => {
    const root = createTempRoot();
    const emptyNewerLegacyPath = path.join(root, 'Claude Agent Teams UI');
    const populatedOlderLegacyPath = path.join(root, 'claude-devtools');
    const currentPath = path.join(root, 'Agent Teams UI');

    fs.mkdirSync(emptyNewerLegacyPath, { recursive: true });
    writeFile(populatedOlderLegacyPath, 'data/attachments/team-a/pre-release.txt', 'pre-release');

    const result = migrateElectronUserDataDirectory(new FakeElectronApp(currentPath));

    expect(result).toMatchObject({
      currentPath,
      legacyPath: populatedOlderLegacyPath,
      migrated: true,
      fallbackToLegacy: false,
      reason: 'migrated',
    });
    expect(readFile(currentPath, 'data/attachments/team-a/pre-release.txt')).toBe('pre-release');
  });

  it('uses the pre-1.0 claude-devtools legacy directory when newer legacy data is absent', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-devtools');
    const currentPath = path.join(root, 'Agent Teams UI');

    writeFile(legacyPath, 'data/attachments/team-a/pre-release.txt', 'pre-release');

    const result = migrateElectronUserDataDirectory(new FakeElectronApp(currentPath));

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: true,
      fallbackToLegacy: false,
      reason: 'migrated',
    });
    expect(readFile(currentPath, 'data/attachments/team-a/pre-release.txt')).toBe('pre-release');
  });
});
