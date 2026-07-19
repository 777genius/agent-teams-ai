// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV,
  AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV,
  applyElectronDevClaudeRootOverrideForWorker,
  applyElectronDevPathOverrides,
} from './electronDevPathOverrides';
import { getClaudeBasePath, setAppDataBasePath, setClaudeBasePathOverride } from './pathDecoder';

describe('applyElectronDevPathOverrides', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setClaudeBasePathOverride(null);
    setAppDataBasePath(null);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies absolute userData and Claude root overrides before Electron storage migration', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-overrides-'));
    tempDirs.push(tempRoot);
    const userDataDir = path.join(tempRoot, 'user-data');
    const claudeRoot = path.join(tempRoot, '.claude');
    const setPathCalls: Array<{ name: string; value: string }> = [];
    const result = applyElectronDevPathOverrides(
      {
        setPath: (name, value) => setPathCalls.push({ name, value }),
      },
      {
        [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir,
        [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
      }
    );

    expect(result).toEqual({
      userDataDir,
      claudeRoot,
      warnings: [],
    });
    expect(setPathCalls).toEqual([
      {
        name: 'userData',
        value: userDataDir,
      },
    ]);
    expect(getClaudeBasePath()).toBe(claudeRoot);
    expect(fs.existsSync(userDataDir)).toBe(true);
    expect(fs.existsSync(claudeRoot)).toBe(true);
  });

  it('rejects relative override paths', () => {
    const setPathCalls: Array<{ name: string; value: string }> = [];
    const result = applyElectronDevPathOverrides(
      {
        setPath: (name, value) => setPathCalls.push({ name, value }),
      },
      {
        [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: 'relative-user-data',
        [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: 'relative-claude-root',
      }
    );

    expect(result.userDataDir).toBeNull();
    expect(result.claudeRoot).toBeNull();
    expect(result.warnings).toEqual([
      `${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV} must be an absolute path.`,
      `${AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV} must be an absolute path.`,
    ]);
    expect(setPathCalls).toEqual([]);
  });

  it('applies the explicit Claude root inside worker-thread startup', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-worker-root-'));
    tempDirs.push(tempRoot);
    const claudeRoot = path.join(tempRoot, '.claude');

    const result = applyElectronDevClaudeRootOverrideForWorker({
      [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
    });

    expect(result).toBe(claudeRoot);
    expect(getClaudeBasePath()).toBe(claudeRoot);
  });
});
