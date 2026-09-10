import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { registerOpenCodeStartupCleanupHandlers } from '@main/ipc/openCodeStartupCleanup';
import { OpenCodeBridgeCommandClient } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import {
  beginOpenCodeStartupRuntimeSweep,
  whenOpenCodeStartupRuntimeSweepSettled,
} from '@main/services/team/opencode/bridge/OpenCodeStartupSweepGate';
import { OpenCodeWindowsStartupCleanup } from '@main/services/team/opencode/bridge/OpenCodeWindowsStartupCleanup';
import { createOpenCodeStartupCleanupAPI } from '@preload/openCodeStartupCleanup';
import { OpenCodeStartupCleanupRecovery } from '@renderer/components/runtime/OpenCodeStartupCleanupRecovery';
import { OPEN_CODE_STARTUP_CLEANUP_RETRY } from '@shared/types/openCodeStartupCleanup';
import { afterEach, expect, it, vi } from 'vitest';

import type { OpenCodeBridgeResult } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeStartupCleanupData } from '@main/services/team/opencode/bridge/OpenCodeStartupCleanupBridge';
import type { ElectronAPI } from '@shared/types/api';
import type { IpcMain } from 'electron';

vi.mock('@features/tmux-installer/main', () => ({
  listRuntimeProcessTableForCurrentPlatform: vi.fn(),
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const empty = { scanned: 0, killed: 0, candidates: [], diagnostics: [] };
const result = (
  coverage: 'partial' | 'complete'
): OpenCodeBridgeResult<OpenCodeStartupCleanupData> => ({
  completedAt: new Date().toISOString(),
  durationMs: 1,
  diagnostics: [],
  runtime: {
    providerId: 'opencode',
    binaryPath: null,
    binaryFingerprint: null,
    version: null,
    capabilitySnapshotId: null,
  },
  schemaVersion: 1,
  requestId: 'original-cleanup-request',
  command: 'opencode.cleanupStartupHosts',
  ok: true,
  data: {
    cleaned: 0,
    remaining: coverage === 'partial' ? 1 : 0,
    hosts: [],
    diagnostics: [],
    startupCleanup: {
      completion: 'drained',
      coverage,
      survivingPids: coverage === 'partial' ? [77] : [],
    },
  },
});
function wire() {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  registerOpenCodeStartupCleanupHandlers({
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
  } as Pick<IpcMain, 'handle'>);
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({} as Electron.IpcMainInvokeEvent, ...args)
  );
  window.electronAPI = { startup: createOpenCodeStartupCleanupAPI({ invoke }) } as ElectronAPI;
  return { invoke };
}
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  beginOpenCodeStartupRuntimeSweep()();
});

it('production recovery UI -> preload -> validated IPC runs one explicit pass and never queues a launch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const { invoke } = wire();
  const cleanup = vi
    .fn()
    .mockResolvedValueOnce(result('partial'))
    .mockResolvedValue(result('complete'));
  const scans = vi.fn(() => Promise.resolve(empty));
  const owner = new OpenCodeWindowsStartupCleanup({
    appStartedAtMs: 100,
    profileScope: 'test-only',
    logWarning: vi.fn(),
    sweep: scans,
    waitMs: () => Promise.resolve(),
  });
  const launch = vi.fn();
  await expect(whenOpenCodeStartupRuntimeSweepSettled().then(launch)).rejects.toThrow(
    /still running/
  );
  await owner.preflight();
  await owner.finish({ cleanupOpenCodeStartupHosts: cleanup });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OpenCodeStartupCleanupRecovery />));
    expect(host.textContent).toContain('was partial');
    await expect(
      invoke(OPEN_CODE_STARTUP_CLEANUP_RETRY, { teamName: 'must-not-launch' })
    ).rejects.toThrow(/no arguments/);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector('button')!.click());
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('finished');
    expect(scans).toHaveBeenCalledTimes(5);
    await whenOpenCodeStartupRuntimeSweepSettled();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('pending recovery observes original late terminal partial response without redispatch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  wire();
  let release!: (value: OpenCodeBridgeResult<OpenCodeStartupCleanupData>) => void;
  const cleanup = vi.fn(
    () =>
      new Promise<OpenCodeBridgeResult<OpenCodeStartupCleanupData>>((resolve) => {
        release = resolve;
      })
  );
  const owner = new OpenCodeWindowsStartupCleanup({
    appStartedAtMs: 100,
    profileScope: 'test-only',
    logWarning: vi.fn(),
    sweep: async () => empty,
    waitMs: () => Promise.resolve(),
  });
  await owner.preflight();
  const operation = owner.finish({ cleanupOpenCodeStartupHosts: cleanup });
  await Promise.resolve();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OpenCodeStartupCleanupRecovery />));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('still running');
    expect((await window.electronAPI.startup!.retryOpenCodeCleanup()).state).toBe('pending');
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(whenOpenCodeStartupRuntimeSweepSettled()).rejects.toThrow();
    release(result('partial'));
    await operation;
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('was partial');
    // A status read consumes terminal observation, without a destructive retry.
    expect(await window.electronAPI.startup!.getOpenCodeCleanupStatus()).toEqual({
      state: 'partial',
      requestId: 'original-cleanup-request',
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    await whenOpenCodeStartupRuntimeSweepSettled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('lost runtime evidence remains blocked through the real recovery API and UI', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  wire();
  const response = {
    ...result('partial'),
    ok: false as const,
    error: {
      kind: 'transport_watchdog_timeout' as const,
      message: 'lost terminal response',
      retryable: true,
    },
  };
  const cleanup = vi.fn(async () => response);
  const owner = new OpenCodeWindowsStartupCleanup({
    appStartedAtMs: 100,
    profileScope: 'test-only',
    logWarning: vi.fn(),
    sweep: async () => empty,
    waitMs: () => Promise.resolve(),
  });
  await owner.preflight();
  await owner.finish({ cleanupOpenCodeStartupHosts: cleanup });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OpenCodeStartupCleanupRecovery />));
    expect(host.textContent).toContain('cannot recover lost runtime evidence');
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('No terminal evidence was found');
    await expect(window.electronAPI.startup!.retryOpenCodeCleanup()).rejects.toThrow(
      /unconfirmed existing operation/
    );
    await expect(whenOpenCodeStartupRuntimeSweepSettled()).rejects.toThrow(/unconfirmed/);
    expect(cleanup).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it('production recovery consumes a late correlated terminal response without a new cleanup pass', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  wire();
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-cleanup-recovery-'));
  let outputPath = '';
  const run = vi.fn(async (input: { args: string[] }) => {
    outputPath = input.args[input.args.indexOf('--output') + 1];
    return { stdout: '', stderr: '', exitCode: null, timedOut: true };
  });
  const bridge = new OpenCodeReadinessBridge(
    new OpenCodeBridgeCommandClient({
      binaryPath: '/test-only/runtime',
      tempDirectory,
      processRunner: { run },
      env: {},
    })
  );
  const scans = vi.fn(() => Promise.resolve(empty));
  const owner = new OpenCodeWindowsStartupCleanup({
    appStartedAtMs: Date.now(),
    profileScope: 'test-only',
    logWarning: vi.fn(),
    sweep: scans,
  });
  await owner.preflight();
  await owner.finish(bridge);
  const requestId = owner.getStatus().requestId!;
  expect(owner.getStatus().state).toBe('unknown');
  const launch = vi.fn();
  await expect(whenOpenCodeStartupRuntimeSweepSettled().then(launch)).rejects.toThrow();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OpenCodeStartupCleanupRecovery />));
    const stillUnknown = result('partial');
    if (stillUnknown.ok) stillUnknown.data.startupCleanup.completion = 'unknown';
    await fs.writeFile(outputPath, JSON.stringify({ ...stillUnknown, requestId }));
    await act(async () => {
      host.querySelector('button')!.click();
      await vi.waitFor(() => expect(owner.getStatus().state).toBe('unknown'));
    });
    expect(run).toHaveBeenCalledTimes(1);
    await fs.writeFile(
      outputPath,
      JSON.stringify({ ...result('partial'), requestId: 'unrelated-operation' })
    );
    await act(async () => {
      host.querySelector('button')!.click();
      await vi.waitFor(() => expect(owner.getStatus().state).toBe('unknown'));
    });
    expect(run).toHaveBeenCalledTimes(1);
    await fs.writeFile(outputPath, JSON.stringify({ ...result('partial'), requestId }));
    await act(async () => {
      host.querySelector('button')!.click();
      await vi.waitFor(() => expect(owner.getStatus().state).toBe('partial'));
    });
    expect(host.textContent).toContain('was partial');
    expect(owner.getStatus().state).toBe('partial');
    expect(run).toHaveBeenCalledTimes(1);
    expect(scans).toHaveBeenCalledTimes(1);
    await whenOpenCodeStartupRuntimeSweepSettled();
    expect(launch).not.toHaveBeenCalled();
    expect(await fs.readdir(tempDirectory)).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

it('initial IPC failure stays visible and Check cleanup only retries status', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const getStatus = vi
    .fn()
    .mockRejectedValueOnce(new Error('Status transport unavailable'))
    .mockResolvedValue({ state: 'partial', requestId: 'observed-request' });
  const retry = vi.fn();
  window.electronAPI = {
    startup: {
      getOpenCodeCleanupStatus: getStatus,
      retryOpenCodeCleanup: retry,
    },
  } as unknown as ElectronAPI;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<OpenCodeStartupCleanupRecovery />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Status transport unavailable'
    );
    expect(container.querySelector('button')?.textContent).toBe('Check cleanup');
    await act(async () => container.querySelector('button')!.click());
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('observed-request');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
