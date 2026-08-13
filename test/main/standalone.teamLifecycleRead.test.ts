import { readFile } from 'node:fs/promises';

import {
  createStandaloneFatalFailStop,
  createStandaloneHostedRouteReadiness,
  registerStandaloneShutdownSignalHandlers,
  resolveStandaloneAuthDataDirectory,
  runStandaloneShutdownLifecycle,
} from '@main/standalone';
import { describe, expect, it, vi } from 'vitest';

describe('standalone team lifecycle read wiring', () => {
  it('keeps owner-backed mutations ready while approval operator routes remain independently unmounted', () => {
    const readiness = createStandaloneHostedRouteReadiness({
      fatalFailStop: false,
      runtimeIdentityAvailable: true,
      diagnosticsAvailable: true,
      lifecycleOwnerAvailable: true,
    });

    expect(readiness.dimensions.mutation.status).toBe('ready');
    expect(readiness.dimensions['runtime-control'].status).toBe('ready');
  });

  it('keeps hosted auth persistence split from the launcher-admitted lifecycle app-data root', async () => {
    expect(resolveStandaloneAuthDataDirectory({ AUTH_DATA_DIR: '/data/auth-explicit' }, true)).toBe(
      '/data/auth-explicit'
    );
    expect(() => resolveStandaloneAuthDataDirectory({}, true)).toThrow(
      'hosted_auth_data_dir_required'
    );

    const source = await readFile('src/main/standalone.ts', 'utf8');
    expect(source).toContain(
      'const authDataDirectory = resolveStandaloneAuthDataDirectory(process.env, hostedMode)'
    );
    expect(source).toContain(
      'const teamIdentityGateway = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })'
    );
    expect(source).toContain('teamIdentityGrantFenceSource = readPorts.teamIdentities');
    expect(source).not.toContain(
      'teamIdentityGrantFenceSource = hostedAuthStorageBackend.teamIdentities'
    );
    expect(source).not.toMatch(
      /const authDataDirectory\s*=\s*[\s\S]{0,120}admittedHostedAppDataRoot/u
    );
    expect(source).not.toContain(
      'const teamIdentityGateway = hostedAuthStorageBackend.teamIdentities'
    );
  });

  it('admits hosted bootstrap and descriptor-revalidated identity before ambient services', async () => {
    const [source, composition, fileSource] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/composition/hosted/teamLifecycleReadComposition.ts', 'utf8'),
      readFile('src/main/composition/hosted/teamLifecycleReadFileSource.ts', 'utf8'),
    ]);

    expect(source).toContain(
      'const appDataRoot = admitHostedReadRoot(bootstrap.runtimeInstance.appDataRoot.reference)'
    );
    expect(source).toContain('admitHostedReadRoot(bootstrap.runtimeInstance.claudeRoot.reference)');
    expect(source).toContain('createTeamLifecycleReadOnlyIdentitySource({ appDataRoot })');
    expect(source).toContain('await readPorts.teamIdentities.listTeamIdentities()');
    expect(source).toContain('new TeamLifecycleReadBootstrapSource({');
    expect(source).toContain('readSerializedBootstrap: () => serializedHostedBootstrap');
    expect(source).toContain(
      'authenticatedBootstrapBinding: productionOwnerAdmission.bootstrapBinding'
    );
    expect(source).toContain(
      'const hostedBootstrapEnvironment = Object.freeze({ ...process.env })'
    );
    expect(source).toContain('readTeamLifecycleReadBootstrapEnvironment(');
    expect(source).toContain('hostedBootstrapEnvironment');
    expect(source).toContain('authority: bootstrap.authority');
    expect(source).toContain('createMountBindingScopedTeamLifecycleReadPorts({');
    expect(source).toContain('mountBinding: bootstrap.mountBinding');
    expect(source).toContain('runtimeInstance: bootstrap.runtimeInstance');
    expect(source).toContain('teamIdentities: teamIdentityGateway');
    expect(source).toContain('...readPorts');
    expect(source).toContain('teamLifecycleReadHost = createTeamLifecycleReadHost(');
    expect(source).toContain('requestSignal: AbortSignal');
    expect(source).toContain('signal: requestSignal');
    expect(source).toContain('createTeamLifecycleReadQueryContext');
    expect(source).not.toContain('signal: new AbortController().signal');
    expect(source).toMatch(
      /const services: HttpServices = \{[\s\S]*teamLifecycleReadHost,[\s\S]*\};/
    );
    expect(source.indexOf('new TeamLifecycleReadBootstrapSource')).toBeLessThan(
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
    expect(fileSource).not.toMatch(
      /\b(readdir|writeFile|mkdir|rm|unlink|rename|spawn|fork|execFile)\s*\(/
    );
    expect(fileSource).toContain('fs.constants.O_RDONLY | NO_FOLLOW');
    expect(fileSource).not.toMatch(/fs\.promises\.readFile\s*\(/);
  });

  it('keeps invalid bootstrap fatal and missing identity storage fail-closed without disposal', async () => {
    const [standalone, desktop] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/index.ts', 'utf8'),
    ]);

    expect(standalone).toContain(
      'let teamLifecycleReadHost: TeamLifecycleReadHost = createUnavailableTeamLifecycleReadHost()'
    );
    expect(standalone).toMatch(
      /if \(hostedMode\) \{[\s\S]*new TeamLifecycleReadBootstrapSource\([\s\S]*\)\.load\(\)/
    );
    expect(standalone).toContain(
      'Hosted team lifecycle identity admission unavailable; canonical reads remain disabled.'
    );
    expect(standalone).not.toContain('internalStorageFeature');
    expect(standalone).not.toContain('internalStorageFeature.dispose');
    expect(desktop).toContain('teamLifecycleReadHost = createUnavailableTeamLifecycleReadHost()');
    expect(desktop).not.toContain('new TeamLifecycleReadBootstrapSource');
  });

  it('obtains and flushes the shared ConfigManager singleton only after root admission', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');
    const shutdownLifecycleSource = await readFile(
      'src/main/standaloneShutdownLifecycle.ts',
      'utf8'
    );
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

    const shutdownStart = source.indexOf('async function shutdown(requestedExitCode = 0)');
    const shutdownEnd = source.indexOf('// Signal Handlers', shutdownStart);
    const shutdownSource = source.slice(shutdownStart, shutdownEnd);
    const flushIndex = shutdownSource.indexOf('await configManager?.flush();');
    const lifecycleStart = shutdownLifecycleSource.indexOf(
      'export async function runStandaloneShutdownLifecycle'
    );
    const lifecycleEnd = shutdownLifecycleSource.indexOf(
      'export interface StandaloneFatalFailStopActions',
      lifecycleStart
    );
    const lifecycleSource = shutdownLifecycleSource.slice(lifecycleStart, lifecycleEnd);

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

  it('closes admissions synchronously and handles only the first fatal failure', async () => {
    let completeShutdown: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeShutdown = resolve;
        })
    );
    const closeAdmissions = vi.fn();
    const setExitCode = vi.fn();
    const exit = vi.fn();
    const logError = vi.fn();
    const setTimer = vi.fn((callback: () => void, timeoutMs: number) =>
      setTimeout(callback, timeoutMs)
    );
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    const fatal = createStandaloneFatalFailStop({
      closeAdmissions,
      shutdown,
      setExitCode,
      exit,
      logError,
      setTimer,
      clearTimer,
    });
    const ownerLoss = new Error('authenticated lifecycle owner lost');

    fatal('Hosted lifecycle orchestrator owner lost', ownerLoss);
    fatal('Second fatal event', new Error('must be ignored'));

    expect(closeAdmissions).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith('Hosted lifecycle orchestrator owner lost:', ownerLoss);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 10_000);

    completeShutdown?.();
    await Promise.resolve();
    expect(clearTimer).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('routes authenticated lifecycle owner loss into the installed fatal fail-stop', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');
    const installIndex = source.indexOf('requestStandaloneFatalFailStop = fatal;');
    const startIndex = source.indexOf('void start().catch');

    expect(source).toContain('onFatalOwnerLoss: (error) => {');
    expect(source).toContain("'Hosted lifecycle orchestrator owner lost'");
    expect(source).toContain('requestStandaloneFatalFailStop?.(');
    expect(installIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(startIndex);
  });

  it('forces a non-zero exit when fatal cleanup cannot complete', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const fatal = createStandaloneFatalFailStop({
        closeAdmissions: vi.fn(),
        shutdown: () => new Promise<void>(() => undefined),
        setExitCode: vi.fn(),
        exit,
        logError: vi.fn(),
        setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
        clearTimer: (timer) => clearTimeout(timer),
        hardExitTimeoutMs: 25,
      });

      fatal('Hosted lifecycle orchestrator owner lost', new Error('owner lost'));
      await vi.advanceTimersByTimeAsync(25);

      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
