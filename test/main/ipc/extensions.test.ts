import {
  initializeExtensionHandlers,
  registerExtensionHandlers,
  removeExtensionHandlers,
} from '@main/ipc/extensions';
import {
  MCP_REGISTRY_INSTALL,
  MCP_REGISTRY_INSTALL_CUSTOM,
  MCP_REGISTRY_UNINSTALL,
  PLUGIN_INSTALL,
  PLUGIN_UNINSTALL,
} from '@preload/constants/ipcChannels';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { PluginInstallRequest, PluginInstallScope } from '@shared/types/extensions';

type IpcHandler = (...args: unknown[]) => Promise<unknown>;
type ExtensionHandlerDependencies = Parameters<typeof initializeExtensionHandlers>;

describe('extension IPC handlers', () => {
  it('accepts global scope for MCP mutations while rejecting it for plugins', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = new Map<string, IpcHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    };
    const facade = { invalidateInstalledCache: vi.fn() };
    const pluginInstaller = {
      install: vi.fn().mockResolvedValue({ state: 'success' }),
      uninstall: vi.fn().mockResolvedValue({ state: 'success' }),
    };
    const mcpInstaller = {
      install: vi.fn().mockResolvedValue({ state: 'success' }),
      installCustom: vi.fn().mockResolvedValue({ state: 'success' }),
      uninstall: vi.fn().mockResolvedValue({ state: 'success' }),
    };

    initializeExtensionHandlers(
      facade as unknown as ExtensionHandlerDependencies[0],
      pluginInstaller as unknown as ExtensionHandlerDependencies[1],
      mcpInstaller as unknown as ExtensionHandlerDependencies[2]
    );
    registerExtensionHandlers(
      ipcMain as unknown as Parameters<typeof registerExtensionHandlers>[0]
    );

    const installRequest = {
      registryId: 'io.example/server',
      serverName: 'example',
      scope: 'global' as const,
      envValues: {},
      headers: [],
    };
    const customInstallRequest = {
      serverName: 'custom-example',
      scope: 'global' as const,
      installSpec: { type: 'stdio' as const, npmPackage: '@example/mcp-server' },
      envValues: {},
      headers: [],
    };

    const installResult = await handlers.get(MCP_REGISTRY_INSTALL)?.({}, installRequest);
    const customInstallResult = await handlers
      .get(MCP_REGISTRY_INSTALL_CUSTOM)
      ?.({}, customInstallRequest);
    const uninstallResult = await handlers
      .get(MCP_REGISTRY_UNINSTALL)
      ?.({}, 'example', 'global');
    const pluginResult = await handlers
      .get(PLUGIN_INSTALL)
      ?.({}, { pluginId: 'example@marketplace', scope: 'global' });

    expect(installResult).toMatchObject({ success: true, data: { state: 'success' } });
    expect(customInstallResult).toMatchObject({ success: true, data: { state: 'success' } });
    expect(uninstallResult).toMatchObject({ success: true, data: { state: 'success' } });
    expect(mcpInstaller.install).toHaveBeenCalledWith(installRequest);
    expect(mcpInstaller.installCustom).toHaveBeenCalledWith(customInstallRequest);
    expect(mcpInstaller.uninstall).toHaveBeenCalledWith('example', 'global', undefined);

    expect(pluginResult).toEqual({ success: false, error: 'Invalid scope: "global"' });
    expect(pluginInstaller.install).not.toHaveBeenCalled();

    for (const invalidScope of ['', null, undefined]) {
      await expect(
        handlers.get(PLUGIN_INSTALL)?.({}, { pluginId: 'example@marketplace', scope: invalidScope })
      ).resolves.toMatchObject({ success: false });
      await expect(
        handlers.get(MCP_REGISTRY_INSTALL)?.({}, { ...installRequest, scope: invalidScope })
      ).resolves.toMatchObject({ success: false });
      await expect(
        handlers
          .get(MCP_REGISTRY_INSTALL_CUSTOM)
          ?.({}, { ...customInstallRequest, scope: invalidScope })
      ).resolves.toMatchObject({ success: false });
    }

    for (const invalidScope of ['', null]) {
      await expect(
        handlers.get(PLUGIN_UNINSTALL)?.({}, 'example@marketplace', invalidScope)
      ).resolves.toMatchObject({ success: false });
      await expect(
        handlers.get(MCP_REGISTRY_UNINSTALL)?.({}, 'example', invalidScope)
      ).resolves.toMatchObject({ success: false });
    }

    expectTypeOf<PluginInstallRequest['scope']>().toEqualTypeOf<PluginInstallScope>();
    expectTypeOf<PluginInstallScope>().toEqualTypeOf<'local' | 'user' | 'project'>();

    removeExtensionHandlers(ipcMain as unknown as Parameters<typeof removeExtensionHandlers>[0]);
    consoleErrorSpy.mockRestore();
  });
});
