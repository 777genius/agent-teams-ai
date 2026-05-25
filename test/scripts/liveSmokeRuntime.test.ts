// @vitest-environment node

import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface LiveSmokeRuntimeModule {
  resolveLiveSmokeOrchestratorCliPath(input?: {
    env?: NodeJS.ProcessEnv;
    repoRoot?: string;
  }): string;
  resolveReleaseSmokeOrchestratorCliPath(input?: {
    env?: NodeJS.ProcessEnv;
    repoRoot?: string;
  }): string;
}

describe('live smoke runtime launcher paths', () => {
  const repoRoot = '/Users/belief/dev/projects/claude/claude_team';
  const siblingRuntimeRoot = '/Users/belief/dev/projects/claude/agent_teams_orchestrator';

  it('defaults live smoke to the source launcher', async () => {
    const { resolveLiveSmokeOrchestratorCliPath } = await loadModule();

    expect(resolveLiveSmokeOrchestratorCliPath({ env: {}, repoRoot })).toBe(
      path.join(siblingRuntimeRoot, 'cli-source')
    );
  });

  it('uses CLAUDE_DEV_RUNTIME_ROOT with cli-source for live smoke', async () => {
    const { resolveLiveSmokeOrchestratorCliPath } = await loadModule();

    expect(
      resolveLiveSmokeOrchestratorCliPath({
        env: { CLAUDE_DEV_RUNTIME_ROOT: '/tmp/runtime-source' },
        repoRoot,
      })
    ).toBe(path.join('/tmp/runtime-source', 'cli-source'));
  });

  it('keeps explicit CLI path overrides authoritative', async () => {
    const { resolveLiveSmokeOrchestratorCliPath } = await loadModule();

    expect(
      resolveLiveSmokeOrchestratorCliPath({
        env: { CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: '  /custom/runtime/cli  ' },
        repoRoot,
      })
    ).toBe('/custom/runtime/cli');
  });

  it('keeps release smoke pointed at the built wrapper', async () => {
    const { resolveReleaseSmokeOrchestratorCliPath } = await loadModule();

    expect(resolveReleaseSmokeOrchestratorCliPath({ env: {}, repoRoot })).toBe(
      path.join(siblingRuntimeRoot, 'cli')
    );
  });
});

async function loadModule(): Promise<LiveSmokeRuntimeModule> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'scripts/lib/live-smoke-runtime.mjs')
  ).href;
  return (await import(`${moduleUrl}?t=${Date.now()}`)) as LiveSmokeRuntimeModule;
}
