import { buildRuntimeTurnSettledEnvironment } from './runtimeTurnSettledEnvironment';
import { buildRuntimeTurnSettledHookSettings } from './runtimeTurnSettledHookSettings';
import { RuntimeTurnSettledSpoolPaths } from './RuntimeTurnSettledSpoolPaths';
import { ShellRuntimeTurnSettledHookScriptInstaller } from './ShellRuntimeTurnSettledHookScriptInstaller';

import type { RuntimeTurnSettledProvider } from '../../core/domain';

export class RuntimeTurnSettledSpoolInitializer {
  private readonly paths: RuntimeTurnSettledSpoolPaths;
  private readonly installer: ShellRuntimeTurnSettledHookScriptInstaller;

  constructor(teamsBasePath: string) {
    this.paths = new RuntimeTurnSettledSpoolPaths(teamsBasePath);
    this.installer = new ShellRuntimeTurnSettledHookScriptInstaller(this.paths);
  }

  getPaths(): RuntimeTurnSettledSpoolPaths {
    return this.paths;
  }

  async buildHookSettings(input: {
    provider: RuntimeTurnSettledProvider;
  }): Promise<Record<string, unknown> | null> {
    if (input.provider !== 'claude') {
      return null;
    }
    const installed = await this.installer.install();
    return buildRuntimeTurnSettledHookSettings({
      scriptPath: installed.scriptPath,
      spoolRoot: installed.spoolRoot,
      provider: input.provider,
    });
  }

  async buildEnvironment(input: {
    provider: RuntimeTurnSettledProvider;
  }): Promise<Record<string, string> | null> {
    if (input.provider !== 'codex' && input.provider !== 'opencode') {
      return null;
    }
    const installed = await this.installer.install();
    return buildRuntimeTurnSettledEnvironment({
      provider: input.provider,
      spoolRoot: installed.spoolRoot,
    });
  }
}
