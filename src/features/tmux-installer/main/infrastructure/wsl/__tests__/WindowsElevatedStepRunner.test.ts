import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { WindowsElevatedStepRunner } from '../WindowsElevatedStepRunner';

describe('WindowsElevatedStepRunner', () => {
  it('returns success when the elevated helper writes a result file', async () => {
    const runner = new WindowsElevatedStepRunner(
      async (_command, args, _options, callback) => {
        const launcherScriptPath = args[4];
        const resultFilePath = path.join(path.dirname(launcherScriptPath), 'result.json');
        await fsp.writeFile(
          resultFilePath,
          JSON.stringify({
            ok: true,
            detail: 'WSL core installation command completed.',
            restartRequired: false,
            featureStates: [
              {
                featureName: 'Microsoft-Windows-Subsystem-Linux',
                state: 'Enabled',
                restartRequired: false,
              },
            ],
          }),
          'utf8'
        );
        callback(null, '', '');
      },
      (prefix) => fsp.mkdtemp(path.join(tmpdir(), prefix))
    );

    const result = await runner.runWslCoreInstall();

    expect(result.outcome).toBe('elevated_succeeded');
    expect(result.detail).toContain('completed');
    expect(result.restartRequired).toBe(false);
    expect(result.featureStates[0]?.featureName).toBe('Microsoft-Windows-Subsystem-Linux');
    expect(result.resultFilePath).toContain('result.json');
  });

  it('parses a UTF-8 BOM result file from PowerShell content writes', async () => {
    const runner = new WindowsElevatedStepRunner(
      async (_command, args, _options, callback) => {
        const launcherScriptPath = args[4];
        const resultFilePath = path.join(path.dirname(launcherScriptPath), 'result.json');
        await fsp.writeFile(
          resultFilePath,
          `\uFEFF${JSON.stringify({
            ok: true,
            detail: 'WSL core installation command completed.',
            restartRequired: true,
            featureStates: [
              {
                featureName: 'VirtualMachinePlatform',
                state: 'EnablePending',
                restartRequired: 'Possible',
              },
            ],
          })}`,
          'utf8'
        );
        callback(null, '', '');
      },
      (prefix) => fsp.mkdtemp(path.join(tmpdir(), prefix))
    );

    const result = await runner.runWslCoreInstall();

    expect(result.outcome).toBe('elevated_succeeded');
    expect(result.detail).toContain('completed');
    expect(result.restartRequired).toBe(true);
    expect(result.featureStates[0]?.state).toBe('EnablePending');
  });

  it('treats a missing result file plus cancel text as elevation cancellation', async () => {
    const runner = new WindowsElevatedStepRunner(
      (_command, _args, _options, callback) => {
        callback(
          Object.assign(new Error('cancelled'), { code: 1 }),
          '',
          'The operation was canceled by the user.'
        );
      },
      (prefix) => fsp.mkdtemp(path.join(tmpdir(), prefix))
    );

    const result = await runner.runWslCoreInstall();

    expect(result.outcome).toBe('elevated_cancelled');
    expect(result.detail).toContain('cancelled');
    expect(result.restartRequired).toBe(false);
    expect(result.featureStates).toEqual([]);
    expect(result.resultFilePath).toBeNull();
  });

  it('decodes localized Windows stderr from the launcher process', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = new WindowsElevatedStepRunner(
        (_command, _args, _options, callback) => {
          callback(
            Object.assign(new Error('restart required'), { code: 1 }),
            Buffer.alloc(0),
            Buffer.from(
              'Требуемая операция выполнена успешно. Чтобы заданные изменения вступили в силу, следует перезагрузить систему.',
              'utf16le'
            )
          );
        },
        (prefix) => fsp.mkdtemp(path.join(tmpdir(), prefix))
      );

      const result = await runner.runWslCoreInstall();

      expect(result.outcome).toBe('elevated_unknown_outcome');
      expect(result.detail).toContain('Требуемая операция выполнена успешно');
      expect(result.restartRequired).toBe(false);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
