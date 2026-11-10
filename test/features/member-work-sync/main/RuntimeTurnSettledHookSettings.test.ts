import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeTurnSettledSpoolPaths } from '@features/member-work-sync/main/infrastructure/RuntimeTurnSettledSpoolPaths';
import { ShellRuntimeTurnSettledHookScriptInstaller } from '@features/member-work-sync/main/infrastructure/ShellRuntimeTurnSettledHookScriptInstaller';
import {
  MEMBER_WORK_SYNC_TURN_SETTLED_HOOK_MARKER,
  buildRuntimeTurnSettledHookCommand,
  buildRuntimeTurnSettledHookSettings,
} from '@features/member-work-sync/main/infrastructure/runtimeTurnSettledHookSettings';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-turn-settled-hook-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime turn-settled hook settings', () => {
  it('builds a shell-quoted command without embedding team identity', () => {
    const command = buildRuntimeTurnSettledHookCommand({
      scriptPath: "/tmp/agent team's hook.sh",
      spoolRoot: '/tmp/member work sync',
      provider: 'claude',
    });

    expect(command).toContain('/bin/sh');
    expect(command).toContain("'/tmp/agent team'\\''s hook.sh'");
    expect(command).toContain("'claude'");
    expect(command).toContain(MEMBER_WORK_SYNC_TURN_SETTLED_HOOK_MARKER);
    expect(command).not.toContain('--team-name');
    expect(command).not.toContain('--agent-name');
  });

  it('builds Claude Stop hook settings with a stable marker', () => {
    const settings = buildRuntimeTurnSettledHookSettings({
      scriptPath: '/tmp/hook.sh',
      spoolRoot: '/tmp/spool',
      provider: 'claude',
    });

    expect(settings).toEqual({
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: expect.stringContaining(MEMBER_WORK_SYNC_TURN_SETTLED_HOOK_MARKER),
              },
            ],
          },
        ],
      },
    });
  });

  it('installs an executable POSIX shell writer and spool directories', async () => {
    const root = makeTempRoot();
    const paths = new RuntimeTurnSettledSpoolPaths(root);
    const installer = new ShellRuntimeTurnSettledHookScriptInstaller(paths);

    const result = await installer.install();

    expect(result.scriptPath).toBe(paths.getHookScriptPath());
    expect(result.spoolRoot).toBe(paths.getRootDir());
    expect(fs.existsSync(paths.getIncomingDir())).toBe(true);
    expect(fs.existsSync(paths.getProcessingDir())).toBe(true);
    expect(fs.existsSync(paths.getProcessedDir())).toBe(true);
    expect(fs.existsSync(paths.getInvalidDir())).toBe(true);

    if (process.platform !== 'win32') {
      const stat = fs.statSync(result.scriptPath);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
    expect(fs.readFileSync(result.scriptPath, 'utf8')).toContain('dd bs="$max_bytes"');
  });
});
