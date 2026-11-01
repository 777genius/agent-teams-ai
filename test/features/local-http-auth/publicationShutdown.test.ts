import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiPublicationLifecycle from '../../../src/main/services/team/ApiPublicationLifecycle';

const ports = vi.hoisted(() => ({
  wait: vi.fn(),
  configure: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
  retire: vi.fn(),
}));
vi.mock('@features/local-http-auth/main', () => ({
  configurePublicationHelper: ports.configure,
  waitForPublicationHelperRetirement: ports.wait,
  disposePublicationHelper: ports.retire,
}));
vi.mock('../../../src/main/services/team/TeamControlApiState', () => ({
  clearTeamControlApiState: ports.clear,
  closeTeamControlApiPublicationAdmission: ports.close,
}));
beforeEach(() => {
  vi.clearAllMocks();
  ports.wait.mockReset().mockResolvedValue('closed');
  ports.clear.mockResolvedValue(undefined);
});

async function source() {
  return ts.createSourceFile(
    'index.ts',
    await readFile(
      new URL('../../../src/main/index.ts', import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  );
}
function compile(node: ts.Node, file: ts.SourceFile): string {
  return ts.transpileModule(node.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
describe('actual app publication retirement quit gates', () => {
  it('refuses bounded pending quit/relaunch and a later explicit attempt rejoins before completion', async () => {
    const file = await source();
    const declaration = file.statements.find(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'requestGuardedAppQuit',
    );
    if (!declaration) throw new Error('Missing quit owner');
    const gate = ports.wait
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('closed');
    const app = { quit: vi.fn(), relaunch: vi.fn() };
    const hide = vi.fn();
    const owner = runInNewContext(
      compile(declaration, file) +
        '\n({ quit: requestGuardedAppQuit, completed: () => shutdownComplete })',
      {
        shutdownComplete: false,
        appQuitFlow: null,
        app,
        requestAllWindowsCloseReadiness: async () => true,
        notificationManager: null,
        BrowserWindow: {
          getAllWindows: () => [{ isDestroyed: () => false, hide }],
        },
        shutdownServices: async () => undefined,
        apiPublication: apiPublicationLifecycle,
        persistentAppLog: null,
        logger: { warn: vi.fn(), error: vi.fn() },
      },
    ) as {
      quit: (reason: 'relaunch') => Promise<boolean>;
      completed: () => boolean;
    };
    await expect(owner.quit('relaunch')).resolves.toBe(false);
    expect(owner.completed()).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    await expect(owner.quit('relaunch')).resolves.toBe(true);
    expect(owner.completed()).toBe(true);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenCalledTimes(2);
  });
  it('fences publication synchronously before the first shutdown await', async () => {
    const file = await source();
    const declaration = file.statements.find(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'shutdownServices',
    );
    if (
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      !declaration.body
    )
      throw new Error('Missing shutdown owner');
    expect(declaration.body.statements[0].getText(file)).toBe(
      'apiPublication.closeAdmission();',
    );
  });
  it('updater cannot mark shutdown complete when physical retirement is pending', async () => {
    const file = await source();
    let callback: ts.ArrowFunction | undefined;
    function walk(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'setBeforeQuitAndInstall' &&
        ts.isArrowFunction(node.arguments[0])
      )
        callback = node.arguments[0];
      ts.forEachChild(node, walk);
    }
    walk(file);
    if (!callback) throw new Error('Missing update retirement owner');
    const code = ts.transpileModule(
      'const callback = ' + callback.getText(file),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    ports.wait.mockResolvedValue('pending');
    const owner = runInNewContext(
      code + '\n({ callback, completed: () => shutdownComplete })',
      {
        shutdownComplete: false,
        requestAllWindowsCloseReadiness: async () => true,
        shutdownServices: async () => undefined,
        apiPublication: apiPublicationLifecycle,
        logger: { error: vi.fn() },
      },
    ) as { callback: () => Promise<void>; completed: () => boolean };
    await expect(owner.callback()).rejects.toThrow('retirement is pending');
    expect(owner.completed()).toBe(false);
  });
  it('configures the desktop artifact before clearing inherited state and keeps physical status distinct', async () => {
    await apiPublicationLifecycle.initializeDesktop(
      { isPackaged: false },
      '/app/dist-electron/main',
    );
    expect(ports.configure).toHaveBeenCalledWith({
      directory: '/app/dist-local-http-auth',
      mode: 'electron-node',
    });
    expect(ports.configure.mock.invocationCallOrder[0]).toBeLessThan(
      ports.clear.mock.invocationCallOrder[0],
    );
    expect(apiPublicationLifecycle.closeAdmission).toBe(ports.close);
    expect(apiPublicationLifecycle.retire).toBe(ports.retire);
    ports.wait.mockResolvedValueOnce('pending');
    await expect(apiPublicationLifecycle.shutdownStatus()).resolves.toContain(
      'retirement is pending',
    );
    expect(ports.wait).toHaveBeenLastCalledWith(0);
  });
  it('uses only the packaged resources directory for the desktop helper', async () => {
    const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      value: '/packaged/resources',
      configurable: true,
    });
    try {
      await apiPublicationLifecycle.initializeDesktop(
        { isPackaged: true },
        '/unrelated/main',
      );
      expect(ports.configure).toHaveBeenCalledWith({
        directory: '/packaged/resources/local-http-auth',
        mode: 'electron-node',
      });
    } finally {
      if (previous) Object.defineProperty(process, 'resourcesPath', previous);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });
});
