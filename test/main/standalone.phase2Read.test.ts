import { readFile } from 'node:fs/promises';

import {
  registerStandaloneShutdownSignalHandlers,
  runStandaloneShutdownLifecycle,
} from '@main/standalone';
import { describe, expect, it, vi } from 'vitest';

describe('standalone Phase 2 read wiring', () => {
  it('admits hosted bootstrap and immutable identity before constructing ambient services', async () => {
    const [source, composition] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/composition/hosted/phase2ReadComposition.ts', 'utf8'),
    ]);

    expect(source).toContain(
      'const appDataRoot = admitHostedReadRoot(bootstrap.runtimeInstance.appDataRoot.reference)'
    );
    expect(source).toContain('admitHostedReadRoot(bootstrap.runtimeInstance.claudeRoot.reference)');
    expect(source).toContain('createPhase2ReadOnlyIdentitySource({ appDataRoot })');
    expect(source).toContain('await readPorts.teamIdentities.listTeamIdentities()');
    expect(source).toContain('new Phase2ReadBootstrapSource({');
    expect(source).toContain('readSerializedBootstrap: () => serializedHostedBootstrap');
    expect(source).toContain('authority: bootstrap.authority');
    expect(source).toContain('createMountBindingScopedPhase2ReadPorts({');
    expect(source).toContain('mountBinding: bootstrap.mountBinding');
    expect(source).toContain('runtimeInstance: bootstrap.runtimeInstance');
    expect(source).toContain('teamIdentities: teamIdentityGateway');
    expect(source).toContain('...readPorts');
    expect(source).toContain('phase2ReadHost = createPhase2ReadHost(composition');
    expect(source).toContain('requestSignal: AbortSignal');
    expect(source).toContain('signal: requestSignal');
    expect(source).toContain(
      'phase2ReadHost = createPhase2ReadHost(composition, createPhase2ReadQueryContext)'
    );
    expect(source).not.toContain('signal: new AbortController().signal');
    expect(source).toMatch(/const services: HttpServices = \{[\s\S]*phase2ReadHost,[\s\S]*\};/);
    expect(source.indexOf('new Phase2ReadBootstrapSource')).toBeLessThan(
      source.indexOf("import('./services/infrastructure/ServiceContext')")
    );
    expect(source.indexOf('await readPorts.teamIdentities.listTeamIdentities()')).toBeLessThan(
      source.indexOf("import('./services/infrastructure/ServiceContext')")
    );
    expect(source).toContain('if (hostedMode) localContext.startCacheOnly()');
    expect(source).not.toContain('JSON.parse');
    expect(source).not.toContain('createInternalStorageFeature');
    expect(source).not.toContain('InternalStorageFeature');
    expect(source).not.toContain('teamIdentityReadBackend');
    expect(source).not.toContain('TeamDataService');
    expect(source).not.toContain('TeamProvisioningService');
    expect(source).not.toContain("import('./services/team')");
    expect(source).not.toContain('getAppDataPath');
    expect(source).not.toContain('scheduleStaleAnthropicTeamApiKeyHelperCleanup');
    expect(composition).not.toContain('TeamDataService');
    expect(composition).not.toContain('TeamProvisioningService');
    expect(composition).not.toMatch(
      /\b(readdir|writeFile|mkdir|rm|unlink|rename|spawn|fork|execFile)\s*\(/
    );
    expect(composition).toContain('fs.constants.O_RDONLY | NO_FOLLOW');
    expect(composition).not.toMatch(/fs\.promises\.readFile\s*\(/);
  });

  it('keeps invalid bootstrap fatal and missing identity storage fail-closed without disposal', async () => {
    const [standalone, desktop] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/index.ts', 'utf8'),
    ]);

    expect(standalone).toContain(
      'let phase2ReadHost: Phase2ReadHost = createUnavailablePhase2ReadHost()'
    );
    expect(standalone).toMatch(
      /if \(hostedMode\) \{[\s\S]*new Phase2ReadBootstrapSource\([\s\S]*\)\.load\(\)/
    );
    expect(standalone).toContain(
      'Hosted Phase 2 identity storage unavailable; canonical reads remain disabled.'
    );
    expect(standalone).not.toContain('internalStorageFeature');
    expect(standalone).not.toContain('internalStorageFeature.dispose');
    expect(desktop).toContain('phase2ReadHost = createUnavailablePhase2ReadHost()');
    expect(desktop).not.toContain('new Phase2ReadBootstrapSource');
  });

  it('obtains and flushes the shared ConfigManager singleton only after root admission', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');
    const configImport = "await import('./services/infrastructure/ConfigManager')";

    expect(source).not.toMatch(/^import .*ConfigManager/m);
    expect(source).toContain(configImport);
    expect(source).toContain('configManager = admittedConfigManager');
    expect(source.indexOf(configImport)).toBeGreaterThan(
      source.indexOf('await readPorts.teamIdentities.listTeamIdentities()')
    );
    expect(source.indexOf(configImport)).toBeGreaterThan(
      source.indexOf('setClaudeBasePathOverride(CLAUDE_ROOT)')
    );

    const shutdownStart = source.indexOf('async function shutdown(): Promise<void>');
    const shutdownEnd = source.indexOf('// Signal Handlers', shutdownStart);
    const shutdownSource = source.slice(shutdownStart, shutdownEnd);
    const flushIndex = shutdownSource.indexOf('await configManager?.flush();');
    const lifecycleStart = source.indexOf('export async function runStandaloneShutdownLifecycle');
    const lifecycleEnd = source.indexOf('type StandaloneShutdownSignal', lifecycleStart);
    const lifecycleSource = source.slice(lifecycleStart, lifecycleEnd);

    expect(flushIndex).toBeGreaterThan(shutdownSource.indexOf('await httpServer.stop();'));
    expect(flushIndex).toBeGreaterThan(shutdownSource.indexOf('localContext.dispose();'));
    expect(shutdownSource.indexOf('exit: (code) => process.exit(code)')).toBeGreaterThan(
      flushIndex
    );
    expect(lifecycleSource).toContain("recordFailure('ConfigManager flush failed during shutdown'");
    expect(lifecycleSource).toContain('if (exitCode === 0) {');
    expect(lifecycleSource).toContain("actions.logInfo('Shutdown complete');");
    expect(lifecycleSource).toContain('actions.exit(exitCode);');
    expect(shutdownSource).toContain('process.exitCode = code;');
    expect(shutdownSource).not.toContain('process.exit(0)');
  });

  it('exits non-zero and never reports completion when final flush fails', async () => {
    const flushFailure = new Error('injected standalone flush failure');
    const logInfo = vi.fn();
    const logError = vi.fn();
    const setExitCode = vi.fn();
    const exit = vi.fn();

    await runStandaloneShutdownLifecycle({
      stopHttpServer: () => Promise.resolve(),
      disposeLocalContext: vi.fn(),
      flushConfig: () => Promise.reject(flushFailure),
      logInfo,
      logError,
      setExitCode,
      exit,
    });

    expect(logError).toHaveBeenCalledWith(
      'ConfigManager flush failed during shutdown:',
      flushFailure
    );
    expect(logInfo).not.toHaveBeenCalledWith('Shutdown complete');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('runs the executable shutdown path from SIGINT and SIGTERM and exits successfully', async () => {
    const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
    const exit = vi.fn();
    const shutdown = vi.fn(() =>
      runStandaloneShutdownLifecycle({
        stopHttpServer: () => Promise.resolve(),
        disposeLocalContext: vi.fn(),
        flushConfig: () => Promise.resolve(),
        logInfo: vi.fn(),
        logError: vi.fn(),
        setExitCode: vi.fn(),
        exit,
      })
    );
    registerStandaloneShutdownSignalHandlers({
      platform: 'linux',
      onSignal: (signal, listener) => listeners.set(signal, listener),
      shutdown,
    });

    listeners.get('SIGINT')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    exit.mockClear();
    listeners.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it('does not register unsupported SIGTERM handling on Windows', () => {
    const onSignal = vi.fn();

    registerStandaloneShutdownSignalHandlers({
      platform: 'win32',
      onSignal,
      shutdown: () => Promise.resolve(),
    });

    expect(onSignal).toHaveBeenCalledOnce();
    expect(onSignal).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
});
