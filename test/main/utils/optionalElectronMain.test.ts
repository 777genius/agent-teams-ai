// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RuntimeContext {
  label: string;
  electronVersion?: string;
  type?: string;
  runAsNode?: string;
}

const runtimeDescriptors = [
  { object: process, property: 'type' },
  { object: process.versions, property: 'electron' },
].map(({ object, property }) => ({
  object,
  property,
  descriptor: Object.getOwnPropertyDescriptor(object, property),
}));
const environmentKeys = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'NODE_ENV',
  'SENTRY_DSN',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDE_TEAM_OPENCODE_TASK_CHANGE_DIAG',
] as const;
const originalRequire = Module.prototype.require;

function setRuntime(context: RuntimeContext): void {
  for (const [object, property, value] of [
    [process, 'type', context.type],
    [process.versions, 'electron', context.electronVersion],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(object, property);
    else Object.defineProperty(object, property, { configurable: true, value });
  }
  if (context.runAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = context.runAsNode;
}

const nodeContexts: RuntimeContext[] = [
  { label: 'ordinary Node' },
  { label: 'ordinary Node with run-as-Node', runAsNode: '1' },
  { label: 'Electron run-as-Node', electronVersion: 'TEST', runAsNode: '1' },
  { label: 'renderer', electronVersion: 'TEST', type: 'renderer' },
  { label: 'utility', electronVersion: 'TEST', type: 'utility' },
  { label: 'browser role without Electron', type: 'browser' },
];

// Intercept the real CommonJS loader, not Vitest's ESM Electron mock. Neither
// Electron's npm installer entry nor the Sentry Electron SDK is evaluated.
describe('optional Electron Main loader boundary', () => {
  let root: string;
  let home: string;
  let electronExports: unknown;
  let electronLoadError: Error | null;
  let loads: string[];
  let savedEnvironment: Record<string, string | undefined>;
  let resetPaths: (() => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'TEST-optional-electron-'));
    home = join(root, 'node-home');
    mkdirSync(home);
    savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.NODE_ENV = 'test';
    setRuntime({ label: 'ordinary Node' });
    loads = [];
    electronExports = join(root, 'electron-binary-not-executed');
    electronLoadError = null;
    resetPaths = undefined;
    vi.spyOn(Module.prototype, 'require').mockImplementation(function (this: NodeModule, id: string) {
      if (id === 'electron') {
        loads.push(id);
        if (electronLoadError) throw electronLoadError;
        return electronExports;
      }
      if (id === '@sentry/electron/main') {
        loads.push(id);
        throw new Error('TEST SDK loader boundary');
      }
      return Reflect.apply(originalRequire, this, [id]) as unknown;
    });
  });

  afterEach(() => {
    resetPaths?.();
    vi.restoreAllMocks();
    for (const { object, property, descriptor } of runtimeDescriptors) {
      if (descriptor) Object.defineProperty(object, property, descriptor);
      else Reflect.deleteProperty(object, property);
    }
    for (const key of environmentKeys) {
      const value = savedEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function loadConsumers() {
    const paths = await import('@main/utils/pathDecoder');
    resetPaths = () => {
      paths.setAppDataBasePath(null);
      paths.setClaudeBasePathOverride(null);
    };
    resetPaths();
    const [{ appendCliAuthDiag }, { appendOpenCodeTaskChangeDiag }, { loadMainSentryArtifactPolicy }] =
      await Promise.all([
        import('@main/utils/cliAuthDiagLog'),
        import('@main/utils/openCodeTaskChangeDiagLog'),
        import('@main/sentryArtifactPolicy'),
      ]);
    return { paths, appendCliAuthDiag, appendOpenCodeTaskChangeDiag, loadMainSentryArtifactPolicy };
  }

  function useMain(runAsNode?: string, isPackaged = true) {
    setRuntime({ label: 'Electron Main', electronVersion: 'TEST', type: 'browser', runAsNode });
    const mainHome = join(root, 'Главная-用户');
    const userData = join(root, 'данные-設定');
    const logs = join(root, 'журнал');
    const app = {
      isPackaged,
      getPath: vi.fn((name: string) => {
        if (name === 'home') return mainHome;
        if (name === 'userData') return userData;
        if (name === 'logs') return logs;
        throw new Error(`Unexpected TEST app path: ${name}`);
      }),
      getAppPath: vi.fn(() => join(root, 'application')),
    };
    electronExports = { app };
    return { app, mainHome, userData, logs };
  }

  it.each(nodeContexts)('does not attempt Electron loading in $label', async (context) => {
    setRuntime(context);
    const { paths, appendCliAuthDiag, appendOpenCodeTaskChangeDiag, loadMainSentryArtifactPolicy } =
      await loadConsumers();
    expect(paths.getHomeDir()).toBe(home);
    expect(paths.getAppDataBasePath()).toBe(join(home, '.agent-teams-ai'));
    expect(paths.getAutoDetectedClaudeBasePath()).toBe(join(home, '.claude'));
    expect(await appendCliAuthDiag({ event: 'TEST' })).toBeNull();
    expect(await appendOpenCodeTaskChangeDiag({ event: 'TEST' })).toBeNull();
    expect(loadMainSentryArtifactPolicy()).toBeNull();
    expect(loads).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([
    { isPackaged: true, runAsNode: undefined },
    { isPackaged: true, runAsNode: '1' },
    { isPackaged: false, runAsNode: undefined },
    { isPackaged: false, runAsNode: '1' },
  ])(
    'uses actual Main paths and logs (packaged=$isPackaged, runAsNode=$runAsNode)',
    async ({ runAsNode, isPackaged }) => {
      // A disabled runAsNode fuse can leave this environment variable present
      // in a real Main process. The actual process role remains authoritative.
      const { app, mainHome, userData, logs } = useMain(runAsNode, isPackaged);
      const { paths, appendCliAuthDiag, appendOpenCodeTaskChangeDiag, loadMainSentryArtifactPolicy } =
        await loadConsumers();
      const beforeLoads = loads.length;
      const beforePaths = app.getPath.mock.calls.length;
      expect(paths.getHomeDir()).toBe(mainHome);
      expect(paths.getAppDataBasePath()).toBe(userData);
      expect(paths.getAutoDetectedClaudeBasePath()).toBe(join(mainHome, '.claude'));
      const authLog = await appendCliAuthDiag({ event: 'TEST-auth' });
      const changeLog = await appendOpenCodeTaskChangeDiag({ event: 'TEST-change' });
      expect(authLog).toBe(join(logs, 'claude-cli-auth-diag.ndjson'));
      expect(changeLog).toBe(join(logs, 'opencode-task-change-diag.ndjson'));
      expect(JSON.parse(readFileSync(authLog!, 'utf8'))).toMatchObject({ event: 'TEST-auth' });
      expect(JSON.parse(readFileSync(changeLog!, 'utf8'))).toMatchObject({ event: 'TEST-change' });
      expect(loadMainSentryArtifactPolicy()).toBeNull(); // No inventory was installed in the fixture.
      expect(app.getAppPath).toHaveBeenCalledOnce();
      expect(app.getPath.mock.calls.slice(beforePaths)).toEqual([
        ['home'], ['userData'], ['home'], ['logs'], ['logs'],
      ]);
      expect(loads.slice(beforeLoads)).toEqual(Array(6).fill('electron'));
    }
  );

  it('honors explicit path overrides before consulting Main', async () => {
    useMain();
    const { paths } = await loadConsumers();
    const appData = join(root, 'explicit-data');
    const claudeData = join(root, 'explicit-claude');
    paths.setAppDataBasePath(appData);
    paths.setClaudeBasePathOverride(claudeData);
    expect(paths.getAppDataBasePath()).toBe(appData);
    expect(paths.getAppDataPath()).toBe(join(appData, 'data'));
    expect(paths.getClaudeBasePath()).toBe(claudeData);
    expect(loads).toEqual([]);
  });

  it('keeps standalone legacy-data migration without loading Electron', async () => {
    const { paths } = await loadConsumers();
    const legacy = join(home, '.claude-agent-teams-ui', 'data');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'TEST.json'), '{"retained":true}\n');
    const current = paths.getAppDataPath();
    expect(current).toBe(join(home, '.agent-teams-ai', 'data'));
    expect(readFileSync(join(current, 'TEST.json'), 'utf8')).toBe('{"retained":true}\n');
    expect(readFileSync(join(legacy, 'TEST.json'), 'utf8')).toBe('{"retained":true}\n');
    expect(loads).toEqual([]);
  });

  it('retains the home and userData fallbacks when Main getPath throws', async () => {
    const { app } = useMain();
    app.getPath.mockImplementation(() => { throw new Error('TEST app not ready'); });
    const { paths } = await loadConsumers();
    expect(paths.getHomeDir()).toBe(home);
    expect(paths.getAppDataBasePath()).toBe(join(home, '.agent-teams-ai'));
    expect(loads).toContain('electron');
  });

  it('retains optional fallbacks when the Main API loader throws', async () => {
    useMain();
    electronLoadError = new Error('TEST unavailable Electron API');
    const { paths, appendCliAuthDiag, appendOpenCodeTaskChangeDiag, loadMainSentryArtifactPolicy } =
      await loadConsumers();
    expect(paths.getHomeDir()).toBe(home);
    expect(paths.getAppDataBasePath()).toBe(join(home, '.agent-teams-ai'));
    expect(await appendCliAuthDiag({ event: 'TEST' })).toBeNull();
    expect(await appendOpenCodeTaskChangeDiag({ event: 'TEST' })).toBeNull();
    expect(loadMainSentryArtifactPolicy()).toBeNull();
    expect(loads).toContain('electron');
  });

  it('retains the userData logs fallback when Main has no logs path', async () => {
    const { app, userData } = useMain();
    app.getPath.mockImplementation((name) => {
      if (name === 'userData') return userData;
      throw new Error('TEST missing logs path');
    });
    const { appendCliAuthDiag, appendOpenCodeTaskChangeDiag } = await loadConsumers();
    expect(await appendCliAuthDiag({ event: 'TEST' }))
      .toBe(join(userData, 'logs', 'claude-cli-auth-diag.ndjson'));
    expect(await appendOpenCodeTaskChangeDiag({ event: 'TEST' }))
      .toBe(join(userData, 'logs', 'opencode-task-change-diag.ndjson'));
  });

  it('does not load the Electron SDK in standalone Node with a configured DSN', async () => {
    await loadConsumers();
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const sentry = await import('@main/sentry');
    sentry.initializeMainSentry();
    expect(sentry.getMainSentryStatus()).toMatchObject({ state: 'failed', reason: 'sdk-load-failed' });
    expect(loads).toEqual([]);
  });

  it('still attempts the configured Electron SDK in actual Main', async () => {
    useMain();
    await loadConsumers();
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const sentry = await import('@main/sentry');
    sentry.initializeMainSentry();
    expect(loads.filter((id) => id === '@sentry/electron/main')).toEqual(['@sentry/electron/main']);
    expect(sentry.getMainSentryStatus()).toMatchObject({ state: 'failed', reason: 'sdk-load-failed' });
  });
});
