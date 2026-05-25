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
  shouldCopyElectronUserDataEntry,
  type ElectronUserDataMigrationApp,
} from '../../../src/main/utils/electronUserDataMigration';

class FakeElectronApp implements ElectronUserDataMigrationApp {
  setPathCalls: { name: string; value: string }[] = [];

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
    const currentPath = path.join('/Users/me/Library/Application Support', 'Agent Teams UI');
    const parentPath = path.dirname(currentPath);

    expect(getLegacyElectronUserDataCandidates(currentPath)).toEqual([
      path.join(parentPath, 'agent-teams-ai'),
      path.join(parentPath, 'Agent Teams AI'),
      path.join(parentPath, 'Claude Agent Teams UI'),
      path.join(parentPath, 'claude-agent-teams-ui'),
      path.join(parentPath, 'claude-devtools'),
      path.join(parentPath, 'claude-code-context'),
    ]);
  });

  it('reuses populated legacy userData by default instead of copying it during startup', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'agent-teams-ai');
    const app = new FakeElectronApp(currentPath);

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
    expect(fs.existsSync(currentPath)).toBe(false);
  });

  it('does not invoke the copy migration in the default startup strategy', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'agent-teams-ai');
    const app = new FakeElectronApp(currentPath);

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app, {
      copyDirectory: () => {
        throw new Error('copy should not run during default startup');
      },
    });

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
    expect(fs.existsSync(currentPath)).toBe(false);
  });

  it('does not treat a cache-only new userData directory as populated', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'agent-teams-ai');
    const app = new FakeElectronApp(currentPath);

    writeFile(currentPath, 'Cache/Cache_Data/blob', 'cache');
    writeFile(currentPath, 'Code Cache/js/cache', 'code cache');
    writeFile(currentPath, 'Partitions/dev/Cache/Cache_Data/blob', 'partition cache');
    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
  });

  it('does not treat Electron-generated shell files as populated new userData', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'agent-teams-ai');
    const app = new FakeElectronApp(currentPath);

    writeFile(currentPath, 'Preferences', '{}');
    writeFile(currentPath, 'Cookies', 'sqlite bytes');
    writeFile(currentPath, 'DIPS', 'tracking state');
    writeFile(currentPath, 'WebStorage/QuotaManager', 'quota');
    writeFile(currentPath, '.updaterId', 'updater');
    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
  });

  it('does not treat regenerated runtime-only folders as completed migration evidence', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'agent-teams-ai');
    const app = new FakeElectronApp(currentPath);

    writeFile(currentPath, 'opencode-bridge/production-e2e-evidence.json', '{}');
    writeFile(currentPath, 'mcp-server/1.3.0/index.js', 'console.log("generated")');
    writeFile(currentPath, 'mcp-configs/agent-teams-mcp-generated.json', '{}');
    writeFile(currentPath, 'Local Storage/leveldb/000003.log', 'renderer local storage');
    writeFile(currentPath, 'IndexedDB/http_localhost_5173.indexeddb.leveldb/000003.log', 'idb');
    writeFile(currentPath, 'Partitions/dev/Local Storage/leveldb/000003.log', 'partition state');
    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
  });

  it('keeps a populated new userData directory after a completed migration', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'agent-teams-ai');
    const app = new FakeElectronApp(currentPath);

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');
    writeFile(currentPath, 'data/attachments/team-a/current.txt', 'current');
    writeFile(currentPath, 'backups/registry.json', '{}');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-populated',
    });
    expect(app.setPathCalls).toEqual([]);
  });

  it('prefers an already populated agent-teams-ai directory over older legacy data', () => {
    const root = createTempRoot();
    const completedNewPath = path.join(root, 'agent-teams-ai');
    const olderLegacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'Agent Teams UI');
    const app = new FakeElectronApp(currentPath);

    writeFile(currentPath, 'opencode-bridge/production-e2e-evidence.json', '{}');
    writeFile(completedNewPath, 'data/attachments/team-a/current.txt', 'current');
    writeFile(olderLegacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath: completedNewPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: completedNewPath },
      { name: 'sessionData', value: completedNewPath },
    ]);
  });

  it('uses populated agent-teams-ai when both current product-name and new package-name paths exist', () => {
    const root = createTempRoot();
    const completedNewPath = path.join(root, 'agent-teams-ai');
    const currentProductPath = path.join(root, 'Agent Teams UI');
    const app = new FakeElectronApp(currentProductPath);

    writeFile(currentProductPath, 'data/attachments/team-a/old.txt', 'old');
    writeFile(completedNewPath, 'data/attachments/team-a/current.txt', 'current');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath: currentProductPath,
      legacyPath: completedNewPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: completedNewPath },
      { name: 'sessionData', value: completedNewPath },
    ]);
    expect(readFile(completedNewPath, 'data/attachments/team-a/current.txt')).toBe('current');
    expect(readFile(currentProductPath, 'data/attachments/team-a/old.txt')).toBe('old');
  });

  it('reuses existing agent-teams-ai data when the current product name is Agent Teams AI', () => {
    const root = createTempRoot();
    const completedNewPath = path.join(root, 'agent-teams-ai');
    const currentProductPath = path.join(root, 'Agent Teams AI');
    const olderProductPath = path.join(root, 'Agent Teams UI');
    const app = new FakeElectronApp(currentProductPath);

    writeFile(currentProductPath, 'Preferences', '{}');
    writeFile(completedNewPath, 'data/attachments/team-a/current.txt', 'current');
    writeFile(olderProductPath, 'data/attachments/team-a/old.txt', 'old');

    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath: currentProductPath,
      legacyPath: completedNewPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: completedNewPath },
      { name: 'sessionData', value: completedNewPath },
    ]);
    expect(readFile(completedNewPath, 'data/attachments/team-a/current.txt')).toBe('current');
    expect(readFile(olderProductPath, 'data/attachments/team-a/old.txt')).toBe('old');
  });

  it('copies legacy app-owned state and durable renderer storage without Chromium caches', async () => {
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
      ['IndexedDB/http_localhost_5173.indexeddb.leveldb/000003.log', 'renderer indexeddb bytes'],
      ['Partitions/dev/Local Storage/leveldb/000003.log', 'dev partition localStorage bytes'],
      [
        'Partitions/dev/IndexedDB/http_localhost_5173.indexeddb.leveldb/000003.log',
        'dev partition indexeddb bytes',
      ],
      ['future-feature/state.json', '{"kept":true}'],
    ] as const;
    const transientFiles = [
      ['Cache/Cache_Data/blob', 'http cache'],
      ['Code Cache/js/cache', 'code cache'],
      ['GPUCache/data_0', 'gpu cache'],
      ['DawnGraphiteCache/data_0', 'graphite cache'],
      ['DawnWebGPUCache/data_0', 'webgpu cache'],
      ['Crashpad/settings.dat', 'crashpad state'],
      ['Session Storage/000003.log', 'session storage'],
      ['Local Storage/leveldb/LOCK', 'stale leveldb lock'],
      ['IndexedDB/http_localhost_5173.indexeddb.leveldb/LOCK', 'stale indexeddb lock'],
      ['Network Persistent State', 'network state'],
      ['DIPS', 'tracking protection state'],
      ['Trust Tokens', 'trust tokens'],
      ['Partitions/dev/Cache/Cache_Data/blob', 'partition http cache'],
      ['Partitions/dev/Code Cache/js/cache', 'partition code cache'],
      ['Partitions/dev/GPUCache/data_0', 'partition gpu cache'],
      ['Partitions/dev/Session Storage/000003.log', 'partition session storage'],
    ] as const;

    for (const [relativePath, content] of knownFiles) {
      writeFile(legacyPath, relativePath, content);
    }
    for (const [relativePath, content] of transientFiles) {
      writeFile(legacyPath, relativePath, content);
    }

    const result = migrateElectronUserDataDirectory(new FakeElectronApp(currentPath), {
      strategy: 'copy',
    });

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
    for (const [relativePath] of transientFiles) {
      expect(fs.existsSync(path.join(currentPath, relativePath))).toBe(false);
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

  it('keeps unknown durable state but skips transient Chromium cache entries', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'Claude Agent Teams UI');

    expect(
      shouldCopyElectronUserDataEntry(legacyPath, path.join(legacyPath, 'data/state.json'))
    ).toBe(true);
    expect(
      shouldCopyElectronUserDataEntry(
        legacyPath,
        path.join(legacyPath, 'future-feature/state.json')
      )
    ).toBe(true);
    expect(
      shouldCopyElectronUserDataEntry(
        legacyPath,
        path.join(legacyPath, 'Partitions/dev/Local Storage/leveldb/000003.log')
      )
    ).toBe(true);
    expect(
      shouldCopyElectronUserDataEntry(
        legacyPath,
        path.join(legacyPath, 'Partitions/dev/Cache/Cache_Data/blob')
      )
    ).toBe(false);
    expect(
      shouldCopyElectronUserDataEntry(
        legacyPath,
        path.join(legacyPath, 'Local Storage/leveldb/LOCK')
      )
    ).toBe(false);
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
      strategy: 'copy',
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
      strategy: 'copy',
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
      strategy: 'copy',
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

  it('uses the lowercase package-name legacy directory when product-name durable data is absent', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'Agent Teams UI');

    writeFile(legacyPath, 'data/attachments/team-a/legacy.txt', 'legacy');

    const app = new FakeElectronApp(currentPath);
    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
    expect(fs.existsSync(path.join(currentPath, 'data/attachments/team-a/legacy.txt'))).toBe(
      false
    );
  });

  it('does not reuse non-durable legacy directories when no durable user data exists', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-agent-teams-ui');
    const currentPath = path.join(root, 'Agent Teams UI');

    writeFile(legacyPath, 'mcp-configs/legacy.json', '{}');
    writeFile(legacyPath, 'opencode-bridge/command-ledger.json', '{"commands":[]}');
    writeFile(legacyPath, 'Local Storage/leveldb/000003.log', 'renderer local storage');

    const app = new FakeElectronApp(currentPath);
    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-missing',
    });
    expect(app.setPathCalls).toEqual([]);
  });

  it('prefers populated older legacy data over an empty newer legacy directory', () => {
    const root = createTempRoot();
    const emptyNewerLegacyPath = path.join(root, 'Claude Agent Teams UI');
    const populatedOlderLegacyPath = path.join(root, 'claude-devtools');
    const currentPath = path.join(root, 'Agent Teams UI');

    fs.mkdirSync(emptyNewerLegacyPath, { recursive: true });
    writeFile(populatedOlderLegacyPath, 'data/attachments/team-a/pre-release.txt', 'pre-release');

    const app = new FakeElectronApp(currentPath);
    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath: populatedOlderLegacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: populatedOlderLegacyPath },
      { name: 'sessionData', value: populatedOlderLegacyPath },
    ]);
    expect(fs.existsSync(path.join(currentPath, 'data/attachments/team-a/pre-release.txt'))).toBe(
      false
    );
  });

  it('uses the pre-1.0 claude-devtools legacy directory when newer legacy data is absent', () => {
    const root = createTempRoot();
    const legacyPath = path.join(root, 'claude-devtools');
    const currentPath = path.join(root, 'Agent Teams UI');

    writeFile(legacyPath, 'data/attachments/team-a/pre-release.txt', 'pre-release');

    const app = new FakeElectronApp(currentPath);
    const result = migrateElectronUserDataDirectory(app);

    expect(result).toMatchObject({
      currentPath,
      legacyPath,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'legacy-reused',
    });
    expect(app.setPathCalls).toEqual([
      { name: 'userData', value: legacyPath },
      { name: 'sessionData', value: legacyPath },
    ]);
    expect(fs.existsSync(path.join(currentPath, 'data/attachments/team-a/pre-release.txt'))).toBe(
      false
    );
  });
});
